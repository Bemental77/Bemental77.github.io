// pokemonarena/js/hub_app_screens.js -- the RENDERERS of the hub's apps: which module draws which app's views (hub_screen.js makes one of each and calls render(f, view) for a view whose
// `app` is the id). The models are listed in hub_apps.js; they are two lists because a model must never import a renderer (hub_model.js stays free of drawing code, and of import cycles).
//
// Pure ES module (browser + Node). To register an app's renderer: import its createScreen and add it under the app's id. A test pins that both lists name the same apps.

import { createScreen as online } from './online_screen.js';
import { createScreen as center } from './center_screen.js';
import { createScreen as builder } from './builder_screen.js';
import { createScreen as trainer } from './trainer_screen.js';

/** { app id: createScreen(ui, h) -> { render(f, view) } } */
export const APP_SCREENS = Object.freeze({ online, center, builder, trainer });
