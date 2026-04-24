import { readFile } from "node:fs/promises"
import { join } from "node:path"

export async function runVersion(): Promise<string> {
  const pkgPath = join(process.cwd(), "package.json")
  const pkg = JSON.parse(await readFile(pkgPath, "utf-8"))
  console.log(`gates v${pkg.version}`)
  return pkg.version
}