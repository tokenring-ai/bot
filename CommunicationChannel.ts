/**
 * A bidirectional conversation with a user or group, used when a bot reaches
 * out on its own initiative and waits for an answer.
 *
 * `close` is typed as `never` so that channels are only ever released through
 * the dispose protocol — use `await using channel = ...`.
 */
export type CommunicationChannel = {
  send: (message: string) => Promise<void>;
  receive: () => AsyncGenerator<string>;
  close?: never;
} & (AsyncDisposable | Disposable);
