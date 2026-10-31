import { readTemplate, renderTemplate } from "./templates.ts";
/** Ephemeral UTF-16LE render input; never written, planned, ledgered or executed as a file. */
export function windowsValidator(root: string): string {
  return renderTemplate("validator.ps1.tmpl", readTemplate("validator.ps1.tmpl"), { root });
}
