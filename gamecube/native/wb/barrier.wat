;; gamecube/native/wb/barrier.wat — the write barrier merged into mp4native.wasm after the link
;; (wb/instrument.sh). binaryen's --instrument-memory turns every load/store into calls to these
;; "env" functions; loads and values pass straight through (and inline away). Every STORE is checked
;; INLINE (wb/inline_hooks.py writes the check at each store site, with the tracked range and the page
;; table's address as constants): a store into a tracked game-state page not yet written in the open
;; frame, one crossing a page boundary inside the range, or one starting just below it calls mp4wb_slow
;; here, which has src/rollback.c copy the page's pre-image into the frame's undo log (copy-on-write).
;; That makes a savestate free: ending a frame closes its log; restoring frame k replays the logs back.
(module
  (import "main" "memory" (memory $mem 0))
  (import "main" "mp4web_cow" (func $cow (param i32)))
  (global $base (mut i32) (i32.const 0))
  (global $pages (mut i32) (i32.const 0))
  (global $table (mut i32) (i32.const 0))      ;; one byte per tracked page: 1 = nothing to do

  (func (export "mp4web_barrier_present") (result i32) (i32.const 1))
  ;; rollback.c calls this once, before anything runs (rollback on/off is the table's contents)
  (func (export "mp4web_barrier_init") (param $b i32) (param $n i32) (param $t i32)
    (global.set $base (local.get $b)) (global.set $pages (local.get $n)) (global.set $table (local.get $t)))

  (func $mp4wb_page (param $a i32)              ;; the tracked page holding byte $a, if any
    (local $p i32)
    (local.set $p (i32.shr_u (i32.sub (local.get $a) (global.get $base)) (i32.const 12)))
    (if (i32.lt_u (local.get $p) (global.get $pages))
      (then (if (i32.eqz (i32.load8_u (i32.add (global.get $table) (local.get $p))))
        (then (call $cow (local.get $p)))))))
  ;; the slow path: the store's first and last byte's pages (a store of <= 8 bytes spans at most two)
  (func $mp4wb_slow (export "mp4wb_slow") (param $a i32) (param $len i32)
    (local $l i32)
    (local.set $l (i32.add (local.get $a) (i32.sub (local.get $len) (i32.const 1))))
    (call $mp4wb_page (local.get $a))
    (if (i32.ne (i32.shr_u (local.get $l) (i32.const 12)) (i32.shr_u (local.get $a) (i32.const 12)))
      (then (call $mp4wb_page (local.get $l)))))

  ;; (inline_hooks.py replaces every call to this with the inline check; kept correct regardless)
  (func (export "store_ptr") (param $id i32) (param $bytes i32) (param $off i32) (param $ptr i32) (result i32)
    (call $mp4wb_slow (i32.add (local.get $ptr) (local.get $off)) (local.get $bytes))
    (local.get $ptr))
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

  ;; bulk ops: instrument.sh rewrites the main module's memory.copy / memory.fill into these; every page
  ;; the destination touches is checked
  (func $mp4wb_bulk (param $d i32) (param $n i32)
    (local $a i32) (local $end i32)
    (if (local.get $n)
      (then
        (local.set $a (local.get $d))
        (local.set $end (i32.add (local.get $d) (local.get $n)))
        (loop $l
          (call $mp4wb_page (local.get $a))
          (local.set $a (i32.and (i32.add (local.get $a) (i32.const 4096)) (i32.const -4096)))
          (br_if $l (i32.lt_u (local.get $a) (local.get $end)))))))
  (func (export "mp4web_mcopy") (param $d i32) (param $s i32) (param $n i32)
    (call $mp4wb_bulk (local.get $d) (local.get $n))
    (memory.copy (local.get $d) (local.get $s) (local.get $n)))
  (func (export "mp4web_mfill") (param $d i32) (param $v i32) (param $n i32)
    (call $mp4wb_bulk (local.get $d) (local.get $n))
    (memory.fill (local.get $d) (local.get $v) (local.get $n)))
)
