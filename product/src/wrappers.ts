import { readTemplate, renderTemplate, TemplateError } from "./templates.ts";
import { windowsValidator } from "./windows-validator.ts";
export { shQuote } from "./templates.ts";
export class WrapperBuildError extends TemplateError {
  constructor(message: string) {
    super(message);
    this.name = "WrapperBuildError";
  }
}
export function userStub(root: string): string {
  return renderTemplate("user-stub.sh.tmpl", readTemplate("user-stub.sh.tmpl"), { root });
}
export function posixWrapper(root: string, mcp: boolean): string {
  const name = mcp ? "trajecta-mcp.sh.tmpl" : "trajecta.sh.tmpl";
  return renderTemplate(name, readTemplate(name), { root });
}
export function windowsWrapper(root: string, powershell: string, mcp: boolean): string {
  const name = mcp ? "trajecta-mcp.cmd.tmpl" : "trajecta.cmd.tmpl";
  return renderTemplate(name, readTemplate(name), { root, powershell, validator: windowsValidator(root) });
}
