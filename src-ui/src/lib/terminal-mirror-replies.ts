import type { IDisposable, IParser } from '@xterm/xterm';

/**
 * A mirrored terminal (the remote page showing another computer's tab) must not answer the program's
 * queries. The other computer's own terminal already answered them; xterm's reply here would reach the
 * PTY as typed input, late, and land on the prompt as text such as `[?1;2c`. A mirror also replays a
 * snapshot of recent output on every attach, which would answer every query in it once more.
 *
 * Handlers added here run before xterm's own; returning true stops a query from being answered, false
 * lets anything that is not a pure query (setting a color, pushing a title) through unchanged.
 */
const WINDOW_REPORTS = new Set([11, 13, 14, 15, 16, 18, 19, 20, 21]);

/** Every value in an OSC color list is a query (`?`); a list that also sets a color is left to xterm. */
const onlyColorQueries = (data: string, step: number) => {
  const parts = data.split(';');
  const values = parts.filter((_, index) => index % step === step - 1);
  return values.length > 0 && parts.length % step === 0 && values.every(value => value === '?');
};

export function muteTerminalReplies(term: { parser: IParser }): () => void {
  const swallow = () => true;
  const { parser } = term;
  const handlers: IDisposable[] = [
    parser.registerCsiHandler({ final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '>', final: 'c' }, swallow),
    parser.registerCsiHandler({ prefix: '=', final: 'c' }, swallow),
    parser.registerCsiHandler({ final: 'n' }, swallow),
    parser.registerCsiHandler({ prefix: '?', final: 'n' }, swallow),
    parser.registerCsiHandler({ intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ prefix: '?', intermediates: '$', final: 'p' }, swallow),
    parser.registerCsiHandler({ final: 't' }, params => WINDOW_REPORTS.has(Number(params[0]))),
    parser.registerDcsHandler({ intermediates: '$', final: 'q' }, swallow),
    parser.registerOscHandler(4, data => onlyColorQueries(data, 2)),
    ...[10, 11, 12].map(code => parser.registerOscHandler(code, data => onlyColorQueries(data, 1))),
  ];
  return () => handlers.forEach(handler => handler.dispose());
}
