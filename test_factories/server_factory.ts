/*
 * @adonisjs/http-server
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import proxyAddr from 'proxy-addr'
import type Encryption from '@adonisjs/encryption'
import type { Application } from '@adonisjs/application'

import { AppFactory } from './app.js'
import { Server } from '../src/server/main.js'
import { EncryptionFactory } from './encryption.js'

import type { LazyImport } from '../src/types/base.js'
import type { RequestConfig } from '../src/types/request.js'
import type { ResponseConfig } from '../src/types/response.js'
import type { MiddlewareAsClass } from '../src/types/middleware.js'

type FactoryParameters = {
  app: Application
  encryption: Encryption
  config: Partial<RequestConfig & ResponseConfig>
}

/**
 * Server factory is used to generate server class instances for
 * testing
 */
export class ServerFactory<
  NamedMiddleware extends Record<string, LazyImport<MiddlewareAsClass>> = any
> {
  #parameters: Partial<FactoryParameters> = {}

  /**
   * Returns the config for the server class
   */
  #getConfig() {
    return {
      allowMethodSpoofing: false,
      trustProxy: proxyAddr.compile('loopback'),
      subdomainOffset: 2,
      generateRequestId: true,
      useAsyncLocalStorage: Boolean(process.env.ASYNC_HOOKS),
      etag: false,
      jsonpCallbackName: 'callback',
      cookie: {
        maxAge: '1 hour',
        path: '/',
        httpOnly: true,
        sameSite: false,
        secure: false,
      },
      ...this.#parameters.config,
    }
  }

  /**
   * Returns an instance of the application class
   */
  #getApp() {
    return this.#parameters.app || new AppFactory().create()
  }

  /**
   * Returns an instance of the encryptor to encrypt
   * signed URLs
   */
  #createEncryption() {
    return this.#parameters.encryption || new EncryptionFactory().create()
  }

  /**
   * Merge factory params
   */
  merge(params: Partial<FactoryParameters>) {
    Object.assign(this.#parameters, params)
    return this
  }

  /**
   * Create server instance
   */
  create() {
    return new Server<NamedMiddleware>(this.#getApp(), this.#createEncryption(), this.#getConfig())
  }
}
