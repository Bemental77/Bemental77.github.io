// pokemonarena/js/center_world.js -- the ROM's overworld and the Trainer Center's room, decoded ONCE per ROM image and shared by the renderer (center_screen.js) and the ctl (center_ctl.js).
//
//   centerWorld(romBytes) -> { world (world_rom.js loadWorld), room (center_room.js roomFromWorld: the plain object the pure model and the room's network rules are handed) }
//
// Nothing ROM-derived is in this file: it only joins the two modules. Throws what loadWorld / roomFromWorld throw (a wrong ROM, which the page has already refused by its hash).

import { loadWorld, GFX, MB } from './world_rom.js';
import { roomFromWorld } from './center_room.js';

const cache = new WeakMap();

export function centerWorld(rom) {
  if (!rom || typeof rom !== 'object') throw new Error('centerWorld(rom): the ROM bytes are missing');
  let c = cache.get(rom);
  if (!c) { const world = loadWorld(rom); c = Object.freeze({ world, room: roomFromWorld(world, { GFX, MB }) }); cache.set(rom, c); }
  return c;
}
