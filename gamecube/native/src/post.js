// gamecube/native/src/post.js (--post-js): hands the page emdawnwebgpu's handle table, which a
// whole-memory snapshot has to save and restore alongside linear memory (C++ objects in memory refer
// to their JS GPU objects by address).
Module['mp4WebGPU'] = (typeof WebGPU !== 'undefined') ? WebGPU : null;
