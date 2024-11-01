type IncomingMessage = import('node:http').IncomingMessage | import('node:http2').Http2ServerRequest

type OutgoingMessage =
  | import('node:http').OutgoingMessage
  | import('node:http').ServerResponse
  | import('node:http2').Http2ServerResponse

declare module 'on-finished' {
  export default function onFinished<
    T extends IncomingMessage | (OutgoingMessage | import('node:http').ServerResponse),
  >(msg: T, listener: (err: Error | null, msg: T) => void): T
}

declare module 'accepts' {
  export default function accepts(req: IncomingMessage): import('accepts').accepts.Accepts
}

declare module 'proxy-addr' {
  declare namespace proxyAddr {
    type Address = 'loopback' | 'linklocal' | 'uniquelocal' | string
    function all(
      req: IncomingMessage,
      trust?: Address | Address[] | ((addr: string, i: number) => boolean)
    ): string[]
    function compile(val: Address | Address[]): (addr: string, i: number) => boolean
  }

  function proxyAddr(
    req: IncomingMessage,
    trust: proxyAddr.Address | proxyAddr.Address[] | ((addr: string, i: number) => boolean)
  ): string

  export = proxyAddr
}

declare module 'type-is' {
  function typeIs(request: IncomingMessage, types: string[]): string | false | null
  function typeIs(request: IncomingMessage, ...types: string[]): string | false | null

  declare namespace typeIs {
    function normalize(type: string): string | false
    function hasBody(request: IncomingMessage): boolean
    function is(mediaType: string, types: string[]): string | false
    function is(mediaType: string, ...types: string[]): string | false
    function mimeMatch(expected: false | string, actual: string): boolean
  }

  export = typeIs
}

declare module 'vary' {
  declare function vary(res: OutgoingMessage, field: string | string[]): void

  export = vary
}
