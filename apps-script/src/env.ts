/** Where the web app lives: saved from the first page view (ScriptApp may report the editor's /dev link). */
export const APP_URL = 'APP_URL';

export function appUrl(): string {
  return (
    PropertiesService.getScriptProperties().getProperty(APP_URL) ??
    ScriptApp.getService().getUrl() ??
    ''
  );
}
