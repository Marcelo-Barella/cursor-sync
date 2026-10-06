import * as os from "node:os";

export function systemTmpDir(): string {
  return os.tmpdir();
}

export function deviceIdentitySalt(): string {
  return `${os.hostname()}:${os.userInfo().username}`;
}

export function childProcessEnv(): NodeJS.ProcessEnv {
  return process.env;
}
