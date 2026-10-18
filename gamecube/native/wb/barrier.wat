;; gamecube/native/wb/barrier.wat — the write barrier merged into mp4native.wasm after the link
;; (wb/instrument.sh). binaryen's --instrument-memory turns every load/store into calls to these
;; "env" functions; loads and values pass straight through (and inline away), while a STORE into
;; the tracked game-state range copies the page's pre-image into the frame's undo log the first time
;; the page is written in that frame (copy-on-write, src/rollback.c). That makes a savestate free:
;; ending a frame closes its log; restoring frame k replays the logs back to k.
(module
  (import "main" "memory" (memory $mem 0))
  (import "main" "mp4web_cow" (func $cow (param i32)))
  (global $base (mut i32) (i32.const 0))
  (global $pages (mut i32) (i32.const 0))      ;; 0 = barrier off
  (global $table (mut i32) (i32.const 0))      ;; one byte per 4 KB page: 1 = already copied this frame
  (global $span8 (mut i32) (i32.const 0))      ;; pages*4096 + 8 (0 = barrier off): the store filter below

  (func (export "mp4web_barrier_present") (result i32) (i32.const 1))
  (func (export "mp4web_barrier_init") (param $b i32) (param $n i32) (param $t i32)
    (global.set $base (local.get $b)) (global.set $pages (local.get $n)) (global.set $table (local.get $t))
    (global.set $span8 (if (result i32) (local.get $n) (then (i32.add (i32.shl (local.get $n) (i32.const 12)) (i32.const 8))) (else (i32.const 0)))))

  (func $mark (param $a i32) (param $len i32)
    (local $p i32)
    (local.set $p (i32.shr_u (i32.sub (local.get $a) (global.get $base)) (i32.const 12)))
    (if (i32.lt_u (local.get $p) (global.get $pages))
      (then (if (i32.eqz (i32.load8_u (i32.add (global.get $table) (local.get $p))))
        (then (call $cow (local.get $p))))))
    ;; the store's last byte is on the next page only if it crosses a 4 KB boundary (base is
    ;; page-aligned, so the address's own low 12 bits say so) — rare, and one AND + compare to rule out
    (if (i32.gt_u (i32.add (i32.and (local.get $a) (i32.const 4095)) (local.get $len)) (i32.const 4096))
      (then (call $mark2 (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1)))))))
  (func $mark2 (param $last i32)
    (local $p i32)
    (local.set $p (i32.shr_u (i32.sub (local.get $last) (global.get $base)) (i32.const 12)))
    (if (i32.lt_u (local.get $p) (global.get $pages))
      (then (if (i32.eqz (i32.load8_u (i32.add (global.get $table) (local.get $p))))
        (then (call $cow (local.get $p)))))))

  ;; EVERY store in the module comes through here (no function is exempt). The filter is the part that
  ;; inlines at each store site: one add, one unsigned compare, one branch. It passes a store whose first
  ;; byte is in [base - 8, base + pages*4096): inside the tracked range, or starting up to 8 bytes below
  ;; it and so possibly reaching into its first page. Everything else (Aurora, WebGPU, libc buffers
  ;; outside the game's ranges) skips the call; inside, $mark does the page check exactly as before.
  (func (export "store_ptr") (param $id i32) (param $bytes i32) (param $off i32) (param $ptr i32) (result i32)
    (if (i32.lt_u (i32.add (i32.sub (i32.add (local.get $ptr) (local.get $off)) (global.get $base)) (i32.const 8)) (global.get $span8))
      (then (call $mark_in (i32.add (local.get $ptr) (local.get $off)) (local.get $bytes))))
    (local.get $ptr))
  (func $mark_in (param $a i32) (param $len i32)
    (if (i32.lt_u (local.get $a) (global.get $base))
      (then (call $mark2 (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1)))) (return)))
    (call $mark (local.get $a) (local.get $len)))
  (func (export "load_ptr") (param i32 i32 i32) (param $ptr i32) (result i32) (local.get $ptr))
  (func (export "load_val_i32") (param i32) (param $v i32) (result i32) (local.get $v))
  (func (export "load_val_i64") (param i32) (param $v i64) (result i64) (local.get $v))
  (func (export "load_val_f32") (param i32) (param $v f32) (result f32) (local.get $v))
  (func (export "load_val_f64") (param i32) (param $v f64) (result f64) (local.get $v))
  (func (export "store_val_i32") (param i32) (param $v i32) (result i32) (local.get $v))
  (func (export "store_val_i64") (param i32) (param $v i64) (result i64) (local.get $v))
  (func (export "store_val_f32") (param i32) (param $v f32) (result f32) (local.get $v))
  (func (export "store_val_f64") (param i32) (param $v f64) (result f64) (local.get $v))
  (func (export "memory_grow_pre") (param i32) (param $d i32) (result i32) (local.get $d))
  (func (export "memory_grow_post") (param i32) (param $r i32) (result i32) (local.get $r))

  ;; bulk ops: instrument.sh rewrites the main module's memory.copy / memory.fill into these
  (func (export "mp4web_mcopy") (param $d i32) (param $s i32) (param $n i32)
    (local $a i32) (local $end i32)
    (if (i32.and (i32.ne (global.get $pages) (i32.const 0)) (i32.ne (local.get $n) (i32.const 0)))
      (then
        (local.set $a (local.get $d))
        (local.set $end (i32.add (local.get $d) (local.get $n)))
        (loop $l
          (call $mark (local.get $a) (i32.const 1))
          (local.set $a (i32.and (i32.add (local.get $a) (i32.const 4096)) (i32.const -4096)))
          (br_if $l (i32.lt_u (local.get $a) (local.get $end))))))
    (memory.copy (local.get $d) (local.get $s) (local.get $n)))
  (func (export "mp4web_mfill") (param $d i32) (param $v i32) (param $n i32)
    (local $a i32) (local $end i32)
    (if (i32.and (i32.ne (global.get $pages) (i32.const 0)) (i32.ne (local.get $n) (i32.const 0)))
      (then
        (local.set $a (local.get $d))
        (local.set $end (i32.add (local.get $d) (local.get $n)))
        (loop $l
          (call $mark (local.get $a) (i32.const 1))
          (local.set $a (i32.and (i32.add (local.get $a) (i32.const 4096)) (i32.const -4096)))
          (br_if $l (i32.lt_u (local.get $a) (local.get $end))))))
    (memory.fill (local.get $d) (local.get $v) (local.get $n)))
)
