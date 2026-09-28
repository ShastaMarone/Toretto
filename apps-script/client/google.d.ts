// The parts of Apps Script's client-side API (available in HtmlService pages) that the page uses.

interface GoogleScriptRunner {
  withSuccessHandler(handler: (value: string) => void): GoogleScriptRunner;
  withFailureHandler(handler: (error: Error) => void): GoogleScriptRunner;
  api(method: string, url: string, bodyJson: string | null): void;
  apiBatch(callsJson: string): void;
  sendQueuedEmails(): void;
}

interface GoogleScriptHistoryEvent {
  state: unknown;
  location: { parameter: Record<string, string>; hash: string };
}

declare const google: {
  script: {
    run: GoogleScriptRunner;
    history: {
      push(state: unknown, params?: Record<string, string>, hash?: string): void;
      replace(state: unknown, params?: Record<string, string>, hash?: string): void;
      setChangeHandler(handler: (event: GoogleScriptHistoryEvent) => void): void;
    };
  };
};

interface Window {
  /** Set by doGet: the screen to open, and the /bootstrap result, so the page starts at once. */
  __TORETTO__?: { path: string; bootstrap: { status: number; body?: unknown } };
}
