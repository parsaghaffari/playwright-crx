/**
 * Copyright (c) Rui Figueira.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { EventEmitter } from 'events';
import { ChannelOwner } from 'playwright-core/lib/client/channelOwner';
import type api from '../types/types';
import type * as channels from '../protocol/channels';
import { Page } from 'playwright-core/lib/client/page';
import type { BrowserContext } from 'playwright-core/lib/client/browserContext';
import type { Mode } from '@recorder/recorderTypes';
import fs from '../shims/fs';

function from<T>(obj: any): T {
  return obj._object as T;
}

export class Crx extends ChannelOwner<channels.CrxChannel> implements api.Crx {

  readonly fs: api.CrxFs = fs;

  private _crxAppPromise?: Promise<CrxApplication>;
  private _incognitoCrxPromise?: Promise<CrxApplication>;

  static from(crx: channels.CrxChannel): Crx {
    return (crx as any)._object;
  }

  /**
   * Force reset the Crx instance, clearing any existing promises
   * and attempting to close any existing applications.
   * This is useful when the application is in an inconsistent state.
   */
  async forceReset(): Promise<void> {
    // Store references to existing promises
    const oldCrxPromise = this._crxAppPromise;
    const oldIncognitoPromise = this._incognitoCrxPromise;

    // Immediately clear the promises to allow new instances
    this._crxAppPromise = undefined;
    this._incognitoCrxPromise = undefined;

    // Try to properly close existing instances
    if (oldCrxPromise) {
      try {
        const app = await oldCrxPromise;
        await app.close().catch(() => {});
      } catch (e) {
        // Ignore errors - we're forcing a reset
      }
    }

    if (oldIncognitoPromise) {
      try {
        const app = await oldIncognitoPromise;
        await app.close().catch(() => {});
      } catch (e) {
        // Ignore errors - we're forcing a reset
      }
    }
  }

  async start(options?: channels.CrxStartOptions): Promise<CrxApplication> {
    try {
      if (options?.incognito) {
        if (this._incognitoCrxPromise)
          throw new Error(`incognito crxApplication is already started`);
        this._incognitoCrxPromise = this._start(options, () => this._incognitoCrxPromise = undefined);
        return await this._incognitoCrxPromise;
      } else {
        if (this._crxAppPromise)
          throw new Error(`crxApplication is already started`);
        this._crxAppPromise = this._start(options ?? {}, () => this._crxAppPromise = undefined);
        return await this._crxAppPromise;
      }
    } catch (error: any) {
      // If we get "already started" error, try to detect if the instance is actually usable
      if (error.message && error.message.includes('already started')) {
        const existingPromise = options?.incognito ? this._incognitoCrxPromise : this._crxAppPromise;
        if (existingPromise) {
          try {
            // Try a simple operation to check if the instance is still valid
            const app = await existingPromise;
            const context = app.context();
            await context.pages(); // This will throw if the connection is broken
            return app; // If we get here, the instance is still usable
          } catch (e) {
            // Instance is broken, force reset and retry
            await this.forceReset();
            return this.start(options);
          }
        }
      }
      throw error;
    }
  }

  private async _start(options: channels.CrxStartOptions, onClose: () => void): Promise<CrxApplication> {
    const crxApp = from<CrxApplication>((await this._channel.start(options ?? {})).crxApplication);
    crxApp.on('close', onClose);
    return crxApp;
  }

  async get(options?: { incognito: boolean }): Promise<CrxApplication | undefined> {
    if (options?.incognito)
      return await this._incognitoCrxPromise;
    else
      return await this._crxAppPromise;
  }
}

export class CrxRecorder extends EventEmitter implements api.CrxRecorder {
  private _channel: channels.CrxApplicationChannel;
  private _hidden: boolean = true;
  private _mode: Mode = 'none';

  constructor(channel: channels.CrxApplicationChannel) {
    super();
    this._channel = channel;
    this._channel.on('hide', () => {
      this._hidden = true;
      this.emit('hide');
    });
    this._channel.on('show', () => {
      this._hidden = false;
      this.emit('show');
    });
    this._channel.on('modeChanged', event => {
      this._mode = event.mode;
      this.emit('modechanged', event);
    });
  }

  mode() {
    return this._mode;
  }

  isHidden() {
    return this._hidden;
  }

  async setMode(mode: Mode) {
    await this._channel.setMode({ mode });
  }

  async show(options?: channels.CrxApplicationShowRecorderOptions) {
    await this._channel.showRecorder(options ?? {});
  }

  async hide() {
    await this._channel.hideRecorder();
  }

  async list(code: string) {
    const { tests } = await this._channel.list({ code });
    return tests;
  }

  async load(code: string) {
    await this._channel.load({ code });
  }

  async run(code: string, page?: Page): Promise<void> {
    await this._channel.run({ code, page: page?._channel });
  }
}

export class CrxApplication extends ChannelOwner<channels.CrxApplicationChannel> implements api.CrxApplication {
  private _context: BrowserContext;
  readonly recorder: api.CrxRecorder;

  static from(crxApplication: channels.CrxApplicationChannel): CrxApplication {
    return (crxApplication as any)._object;
  }

  constructor(parent: ChannelOwner, type: string, guid: string, initializer: channels.CrxApplicationInitializer) {
    super(parent, type, guid, initializer);
    this._context = (initializer.context as any)._object;
    this.recorder = new CrxRecorder(this._channel);
    this._channel.on('attached', ({ page, tabId }) => {
      this.emit('attached', { tabId, page: Page.from(page) });
    });
    this._channel.on('detached', ({ tabId }) => {
      this.emit('detached', tabId);
    });
    this._context.on('close', () => {
      this.emit('close');
    });
  }

  context() {
    return this._context;
  }

  pages(): api.Page[] {
    return this._context.pages();
  }

  async attach(tabId: number) {
    return from<Page>((await this._channel.attach({ tabId })).page);
  }

  async attachAll(options?: channels.CrxApplicationAttachAllOptions) {
    // we must convert url as string into string[]
    const { url: urlOrUrls, ...remaining } = options ?? {};
    const url = urlOrUrls ? typeof urlOrUrls === 'string' ? [urlOrUrls] : urlOrUrls : undefined;
    const params = { ...remaining, url };

    return (await this._channel.attachAll(params)).pages.map(p => from<Page>(p));
  }

  async detach(tabIdOrPage: number | Page): Promise<void> {
    const params = typeof tabIdOrPage === 'number' ?
      { tabId: tabIdOrPage } :
      { page: tabIdOrPage._channel };

    await this._channel.detach(params);
  }

  async detachAll(): Promise<void> {
    await this._channel.detachAll();
  }

  async newPage(options?: channels.CrxApplicationNewPageOptions) {
    return from<Page>((await this._channel.newPage(options ?? {})).page);
  }

  async close() {
    await this._channel.close();
  }
}
