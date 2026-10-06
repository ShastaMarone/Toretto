/** Where the web app lives: saved from the first page view (ScriptApp may report the editor's /dev link). */
export const APP_URL = 'APP_URL';

/**
 * The prefix for links in emails: callers add a screen like "/my-schedule".
 * Apps Script doesn't serve …/exec/my-schedule (it says the file can't be
 * opened), so the screen travels in ?page= instead, which doGet reads.
 */
export function appUrl(): string {
  const base =
    PropertiesService.getScriptProperties().getProperty(APP_URL) ??
    ScriptApp.getService().getUrl() ??
    '';
  return base ? `${base.replace(/\/exec.*$/, '/exec')}?page=` : '';
}
