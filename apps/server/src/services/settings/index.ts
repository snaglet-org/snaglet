/**
 * Settings service — public exports.
 *
 * Importing this module side-effect-loads every category file so the
 * registry is populated by the time the first caller hits
 * `settingsService.read(def)`. Category files only need to be created;
 * they don't need to be imported elsewhere — this barrel does it.
 */

// Side-effect imports: populate the registry on first load. Category
// files use `defineCategory`, which registers each setting at module
// load time. Empty stubs are fine — once a subtask fills one in, no
// change is needed here.
import './categories/search';
import './categories/tool';
import './categories/budget';
import './categories/dispatch';
import './categories/agent';
import './categories/workers';
import './categories/localModels';
import './categories/automations';
import './categories/home';
import './categories/onboarding';
import './categories/workspace';

export { settingsService } from './settingsService';
export type { SettingsChangeEvent } from './settingsService';
export { registry } from './registry';
export { defineCategory, defineSetting } from './defineSetting';
export type { SettingDef, SettingInput, CategoryDefs } from './defineSetting';
import './categories/appearance';
