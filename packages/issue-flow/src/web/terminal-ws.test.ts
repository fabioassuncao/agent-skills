import { describe, expect, it } from 'vitest';
import {
  frameOutput,
  frameScrollback,
  isAllowedOrigin,
  MAX_BUFFERED_BYTES,
  matchTerminalWebSocketPath,
  parseTerminalClientMessage,
  TERMINAL_WS_PATH,
} from './terminal-ws.js';

/**
 * The protocol, framing and admission rules of the terminal socket. The
 * behaviour that needs a real server and a real tmux — C6 and C9 — is in
 * `terminal-ws.integration.test.ts`.
 */
describe('parseTerminalClientMessage', () => {
  it('accepts the four messages the upstream protocol defines', () => {
    expect(parseTerminalClientMessage('{"type":"input","data":"ls\\r"}')).toEqual({
      type: 'input',
      data: 'ls\r',
    });
    expect(parseTerminalClientMessage('{"type":"sendKeys","hexBytes":["0x1b","0x41"]}')).toEqual({
      type: 'sendKeys',
      hexBytes: ['0x1b', '0x41'],
    });
    expect(parseTerminalClientMessage('{"type":"selectPane","pane":2}')).toEqual({
      type: 'selectPane',
      pane: 2,
    });
    expect(parseTerminalClientMessage('{"type":"resize","cols":120,"rows":40}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });

  // The addition §15 requires: a returning client says how far it got.
  it('carries the last offset and the initial pane on a resize', () => {
    expect(
      parseTerminalClientMessage(
        '{"type":"resize","cols":120,"rows":40,"initialPane":1,"lastOffset":4096}',
      ),
    ).toEqual({ type: 'resize', cols: 120, rows: 40, initialPane: 1, lastOffset: 4096 });
  });

  // This message crosses a process boundary from a browser. Nothing
  // unrecognised may reach a pty.
  it('rejects anything it does not recognise, rather than guessing', () => {
    expect(parseTerminalClientMessage('not json')).toBeNull();
    expect(parseTerminalClientMessage('[]')).toBeNull();
    expect(parseTerminalClientMessage('null')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"exec","command":"rm -rf /"}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"input"}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"input","data":42}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"sendKeys","hexBytes":[1,2]}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"selectPane","pane":"first"}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"resize","cols":0,"rows":40}')).toBeNull();
    expect(parseTerminalClientMessage('{"type":"resize","cols":"120","rows":40}')).toBeNull();
  });

  it('truncates fractional dimensions instead of passing them to stty', () => {
    expect(parseTerminalClientMessage('{"type":"resize","cols":120.7,"rows":40.2}')).toEqual({
      type: 'resize',
      cols: 120,
      rows: 40,
    });
  });
});

describe('framing', () => {
  // One character and one integer before the payload: a chunk of terminal
  // output costs an `indexOf` on the client and no JSON on either side.
  it('prefixes output with its offset and nothing else', () => {
    expect(frameOutput(4096, 'hello')).toBe('o4096\nhello');
    expect(frameScrollback(4096, 'hello')).toBe('s4096\nhello');
  });

  it('leaves the payload untouched, newlines included', () => {
    const payload = 'line one\nline two\n';
    expect(frameOutput(10, payload).slice('o10\n'.length)).toBe(payload);
  });

  it('distinguishes a replay from live output by its first character', () => {
    expect(frameScrollback(1, 'x')[0]).toBe('s');
    expect(frameOutput(1, 'x')[0]).toBe('o');
  });
});

describe('isAllowedOrigin', () => {
  // Absent means a non-browser client, which the same-origin policy does not
  // apply to and which had to know the token anyway.
  it('allows a client with no Origin at all', () => {
    expect(isAllowedOrigin(undefined, 3737)).toBe(true);
    expect(isAllowedOrigin('', 3737)).toBe(true);
  });

  it('allows a page this server served', () => {
    expect(isAllowedOrigin('http://127.0.0.1:3737', 3737)).toBe(true);
    expect(isAllowedOrigin('http://localhost:3737', 3737)).toBe(true);
    expect(isAllowedOrigin('http://[::1]:3737', 3737)).toBe(true);
  });

  // Without this, any site the user visits could open a shell on their machine
  // the moment it guessed the port.
  it('refuses any other page, including the same host on another port', () => {
    expect(isAllowedOrigin('https://evil.example', 3737)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:3738', 3737)).toBe(false);
    expect(isAllowedOrigin('http://localhost', 3737)).toBe(false);
  });
});

describe('protocol constants', () => {
  it('serves the socket on its own path, so other upgrades are untouched', () => {
    expect(TERMINAL_WS_PATH).toBe('/ws/terminal');
  });

  it('caps the send buffer, which the upstream never does', () => {
    expect(MAX_BUFFERED_BYTES).toBe(1024 * 1024);
  });

  it('routes both the hub socket and the project-prefixed socket', () => {
    expect(matchTerminalWebSocketPath('/ws/terminal')).toBeNull();
    expect(matchTerminalWebSocketPath('/project-alpha/ws/terminal')).toBe('project-alpha');
    expect(matchTerminalWebSocketPath('/project%20alpha/ws/terminal')).toBe('project alpha');
    expect(matchTerminalWebSocketPath('/project-alpha/ws/other')).toBeUndefined();
    expect(matchTerminalWebSocketPath('/%ZZ/ws/terminal')).toBeUndefined();
  });
});
