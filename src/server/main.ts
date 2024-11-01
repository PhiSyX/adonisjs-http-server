/*
 * @adonisjs/http-server
 *
 * (c) AdonisJS
 *
 * For the full copyright and license information, please view the LICENSE
 * file that was distributed with this source code.
 */

import onFinished from 'on-finished'
import Middleware from '@poppinss/middleware'
import type { Logger } from '@adonisjs/logger'
import type { Encryption } from '@adonisjs/encryption'
import type { Application } from '@adonisjs/application'
import type { EmitterLike } from '@adonisjs/events/types'
import { ContainerResolver, moduleCaller, moduleImporter } from '@adonisjs/fold'

import type { Server as HttpsServer } from 'node:https'
import type { Http2SecureServer, Http2ServerRequest, Http2ServerResponse } from 'node:http2'
import type { ServerResponse, IncomingMessage, Server as Http1Server } from 'node:http'

import type { LazyImport } from '../types/base.js'
import type { MiddlewareAsClass, ParsedGlobalMiddleware } from '../types/middleware.js'
import type {
  ServerConfig,
  HttpServerEvents,
  ServerErrorHandler,
  ErrorHandlerAsAClass,
  TestingMiddlewarePipeline,
} from '../types/server.js'

import { Qs } from '../qs.js'
import debug from '../debug.js'
import { Request } from '../request.js'
import { Response } from '../response.js'
import { Router } from '../router/main.js'
import { HttpContext } from '../http_context/main.js'
import { finalHandler } from './factories/final_handler.js'
import { writeResponse } from './factories/write_response.js'
import { asyncLocalStorage } from '../http_context/local_storage.js'
import { middlewareHandler } from './factories/middleware_handler.js'

type HttpServer = Http1Server | HttpsServer | Http2SecureServer
type HttpServerRequest = IncomingMessage | Http2ServerRequest
type HttpServerResponse = ServerResponse | Http2ServerResponse

/**
 * The HTTP server implementation to handle incoming requests and respond using the
 * registered routes.
 */
export class Server {
  #booted: boolean = false

  /**
   * The default error handler to use
   */
  #defaultErrorHandler: ServerErrorHandler = {
    report() {},
    handle(error, ctx) {
      ctx.response.status(error.status || 500).send(error.message || 'Internal server error')
    },
  }

  /**
   * Logger instance, a child logger is added
   * to the context to have request specific
   * logging capabilities.
   */
  #logger: Logger

  /**
   * Registered error handler (if any)
   */
  #errorHandler?: LazyImport<ErrorHandlerAsAClass>

  /**
   * Resolved error handler is an instance of the lazily imported error
   * handler class.
   */
  #resolvedErrorHandler: ServerErrorHandler = this.#defaultErrorHandler

  /**
   * Emitter is required to notify when a request finishes
   */
  #emitter: EmitterLike<HttpServerEvents>

  /**
   * The application instance to be shared with the router
   */
  #app: Application<any>

  /**
   * The encryption instance to be shared with the router
   */
  #encryption: Encryption

  /**
   * Server config
   */
  #config: ServerConfig

  /**
   * Query string parser used by the server
   */
  #qsParser: Qs

  /**
   * Server middleware stack runs on every incoming HTTP request
   */
  #serverMiddlewareStack?: Middleware<ParsedGlobalMiddleware>

  /**
   * Reference to the router used by the server
   */
  #router: Router

  /**
   * Reference to the underlying Node HTTP server in use
   */
  #nodeHttpServer?: HttpServer

  /**
   * Middleware store to be shared with the routes
   */
  #middleware: ParsedGlobalMiddleware[] = []

  /**
   * The request error response is attached to the middleware
   * pipeline to intercept errors and invoke the user
   * registered error handler.
   *
   * We share this with the route middleware pipeline as well,
   * so that it does not throw any exceptions
   */
  #requestErrorResponder: ServerErrorHandler['handle'] = (error, ctx) => {
    this.#resolvedErrorHandler.report(error, ctx)
    return this.#resolvedErrorHandler.handle(error, ctx)
  }

  /**
   * Check if the server has already been booted
   */
  get booted() {
    return this.#booted
  }

  /**
   * Know if async local storage is enabled or not.
   */
  get usingAsyncLocalStorage() {
    return asyncLocalStorage.isEnabled
  }

  constructor(
    app: Application<any>,
    encryption: Encryption,
    emitter: EmitterLike<HttpServerEvents>,
    logger: Logger,
    config: ServerConfig
  ) {
    this.#app = app
    this.#emitter = emitter
    this.#config = config
    this.#logger = logger
    this.#encryption = encryption
    this.#qsParser = new Qs(this.#config.qs)
    this.#router = new Router(this.#app, this.#encryption, this.#qsParser)
    this.#createAsyncLocalStore()

    debug('server config: %O', this.#config)
  }

  /**
   * Create async local storage store when enabled
   */
  #createAsyncLocalStore() {
    if (this.#config.useAsyncLocalStorage) {
      debug('creating ALS store for HTTP context')
      asyncLocalStorage.create()
    } else {
      asyncLocalStorage.destroy()
    }
  }

  /**
   * Creates an instance of the server middleware stack
   */
  #createServerMiddlewareStack() {
    this.#serverMiddlewareStack = new Middleware()
    this.#middleware.forEach((middleware) => this.#serverMiddlewareStack!.add(middleware))
    this.#serverMiddlewareStack.freeze()
    this.#middleware = []
  }

  /**
   * Handles the HTTP request
   */
  #handleRequest(ctx: HttpContext, resolver: ContainerResolver<any>) {
    return this.#serverMiddlewareStack!.runner()
      .errorHandler((error) => this.#requestErrorResponder(error, ctx))
      .finalHandler(finalHandler(this.#router!, resolver, ctx, this.#requestErrorResponder))
      .run(middlewareHandler(resolver, ctx))
      .catch((error) => {
        ctx.logger.fatal({ err: error }, 'Exception raised by error handler')
        return this.#defaultErrorHandler.handle(error, ctx)
      })
      .finally(writeResponse(ctx))
  }

  /**
   * Creates a pipeline of middleware.
   */
  pipeline(middleware: MiddlewareAsClass[]): TestingMiddlewarePipeline {
    const middlewareStack = new Middleware<ParsedGlobalMiddleware>()
    middleware.forEach((one) => {
      middlewareStack.add(moduleCaller(one, 'handle').toHandleMethod())
    })

    middlewareStack.freeze()
    const stackRunner = middlewareStack.runner()

    return {
      finalHandler(handler) {
        stackRunner.finalHandler(handler)
        return this
      },
      errorHandler(handler) {
        stackRunner.errorHandler(handler)
        return this
      },
      run(ctx) {
        return stackRunner.run((handler, next) => {
          return handler.handle(ctx.containerResolver, ctx, next)
        })
      },
    }
  }

  /**
   * Define an array of middleware to use on all the incoming HTTP request.
   * Calling this method multiple times pushes to the existing list
   * of middleware
   */
  use(middleware: LazyImport<MiddlewareAsClass>[]): this {
    middleware.forEach((one) =>
      this.#middleware.push(moduleImporter(one, 'handle').toHandleMethod())
    )

    return this
  }

  /**
   * Register a custom error handler for HTTP requests.
   * All errors will be reported to this method
   */
  errorHandler(handler: LazyImport<ErrorHandlerAsAClass>): this {
    this.#errorHandler = handler
    return this
  }

  /**
   * Boot the server. Calling this method performs the following actions.
   *
   * - Register routes with the store.
   * - Resolve and construct the error handler.
   */
  async boot() {
    if (this.#booted) {
      return
    }

    debug('booting HTTP server')

    /**
     * Creates the middleware stack for the server
     */
    this.#createServerMiddlewareStack()

    /**
     * Commit routes
     */
    this.#router.commit()

    /**
     * Register custom error handler
     */
    if (this.#errorHandler) {
      if (debug.enabled) {
        debug('using custom error handler "%s"', this.#errorHandler)
      }

      const moduleExports = await this.#errorHandler()
      this.#resolvedErrorHandler = await this.#app.container.make(moduleExports.default)
    }

    this.#booted = true
  }

  /**
   * Set the HTTP server instance used to listen for requests.
   */
  setNodeServer(server: HttpServer) {
    this.#nodeHttpServer = server
  }

  /**
   * Returns reference to the underlying HTTP server
   * in use
   */
  getNodeServer() {
    return this.#nodeHttpServer
  }

  /**
   * Returns reference to the router instance used
   * by the server.
   */
  getRouter(): Router {
    return this.#router
  }

  /**
   * Creates an instance of the [[Request]] class
   */
  createRequest(req: HttpServerRequest, res: HttpServerResponse) {
    return new Request(req, res, this.#encryption, this.#config, this.#qsParser)
  }

  /**
   * Creates an instance of the [[Response]] class
   */
  createResponse(req: HttpServerRequest, res: HttpServerResponse) {
    return new Response(req, res, this.#encryption, this.#config, this.#router, this.#qsParser)
  }

  /**
   * Creates an instance of the [[HttpContext]] class
   */
  createHttpContext(request: Request, response: Response, resolver: ContainerResolver<any>) {
    return new HttpContext(
      request,
      response,
      this.#logger.child({ request_id: request.id() }),
      resolver
    )
  }

  /**
   * Handle request
   */
  handle(req: HttpServerRequest, res: HttpServerResponse) {
    /**
     * Setup for the "http:request_finished" event
     */
    const hasRequestListener = this.#emitter.hasListeners('http:request_completed')
    const startTime = hasRequestListener ? process.hrtime() : null

    /**
     * Creating essential instances
     */
    const resolver = this.#app.container.createResolver()
    const ctx = this.createHttpContext(
      this.createRequest(req, res),
      this.createResponse(req, res),
      resolver
    )

    /**
     * Emit event when listening for the request_finished event
     */
    if (startTime) {
      onFinished(res, () => {
        this.#emitter.emit('http:request_completed', {
          ctx: ctx,
          duration: process.hrtime(startTime),
        })
      })
    }

    /**
     * Handle request
     */
    if (this.usingAsyncLocalStorage) {
      return asyncLocalStorage.storage!.run(ctx, () => this.#handleRequest(ctx, resolver))
    }
    return this.#handleRequest(ctx, resolver)
  }
}
