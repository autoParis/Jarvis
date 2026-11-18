// The shape every concept route shares. main.ts reads the request, then tries each route in turn: a route answers
// with a RouteResult for a URL it owns, and undefined for any other, so main.ts tries the next one.
export type RouteResult = { status: number; body?: unknown };
/** The request's JSON body. Read only when called, and once: the routes main.ts tries before the match never read it. */
export type Body = () => Promise<any>;

/** A memoized body reader, so the route that matches reads the stream and no other route can read it twice. */
export function lazyBody(read: () => Promise<any>): Body {
  let p: Promise<any> | undefined;
  return () => (p ??= read());
}
