/** Definitive rejection, unlike a transport failure with an unknown outcome. */
export class ClientRequestNotPendingError extends Error {
  constructor() {
    super('This request is no longer pending. Your answer was not sent.');
    this.name = 'ClientRequestNotPendingError';
  }
}
