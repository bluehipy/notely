Object.defineProperty(document, 'domain', {
  value: location.hostname,
  writable: false,
  configurable: false
});
