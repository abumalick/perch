import { app } from './app';
import { home } from './home';
import { load } from './load';
import { status } from './status';
import { settings } from './settings';
import { pairing } from './pairing';
import { refusal } from './refusal';
import { presets } from './presets';
import { create } from './create';
import { files } from './files';
import { viewer } from './viewer';
import { browser } from './browser';
import { terminal } from './terminal';
import { keyboard } from './keyboard';
import { dictation } from './dictation';
import { errors } from './errors';

// The source of truth: every other language is typed against it, so a missing or misshapen
// entry fails the typecheck. An entry is a string, or a function when it takes values.
export const en = { app, home, load, status, settings, pairing, refusal, presets, create, files, viewer, browser, terminal, keyboard, dictation, errors };

export type Messages = typeof en;
