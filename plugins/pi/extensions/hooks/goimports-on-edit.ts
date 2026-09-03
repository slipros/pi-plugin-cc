/**
 * goimports-on-edit — PostToolUse Write|Edit.
 *
 * Автоформат Go-файлов после правки: goimports + gofumpt (если установлены).
 *
 * Управление: GOIMPORTS_ON_EDIT=0 — выключить.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { joinPath } from "./utils";

export default function (pi: ExtensionAPI) {
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		if (process.env.GOIMPORTS_ON_EDIT === "0") return undefined;
		const path = (event.input as { path?: string }).path ?? "";
		if (!path.endsWith(".go")) return undefined;
		const abs = path.startsWith("/") ? path : joinPath(ctx.cwd, path);
		await pi.exec("bash", [
			"-c",
			`if command -v goimports >/dev/null 2>&1; then goimports -w "$1" 2>/dev/null; fi; if command -v gofumpt >/dev/null 2>&1; then gofumpt -w "$1" 2>/dev/null; fi`,
			"pi-hook",
			abs,
		]);
		return undefined;
	});
}
