import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VOCABULARY_URLS, countTokens as estimateTokens, getTiktoken } from "@hyvmind/tiktoken-ts";
import type { Paths } from "./paths.ts";

export const ENCODING = "o200k_base";
/** SHA-256 of OpenAI's o200k_base.tiktoken, as pinned by tiktoken itself. */
const VOCAB_SHA256 = "446a9538cb6c348e3516120d7c08b09f57c36495e2acfffe59a5bf8b0cfb1a2d";

export interface Tokenizer {
	/** False when the vocabulary was unavailable and counts are heuristic estimates. */
	exact: boolean;
	/** Why the exact tokenizer is unavailable. */
	warning?: string;
	count(text: string): number;
}

export interface TokenizerOptions {
	/** Download the vocabulary text; injectable for tests. */
	download?: () => Promise<string>;
	sha256?: string;
}

const sha256 = (text: string): string => new Bun.CryptoHasher("sha256").update(text).digest("hex");

/**
 * Exact o200k_base tokenizer. The vocabulary is downloaded once, verified against its pinned
 * hash and kept under the curator directory, so later runs work offline. When it cannot be
 * obtained, counts fall back to the package's heuristic estimator.
 */
export async function openTokenizer(paths: Paths, options: TokenizerOptions = {}): Promise<Tokenizer> {
	const file = join(paths.curatorDir, "vocab", `${ENCODING}.tiktoken`);
	const expected = options.sha256 ?? VOCAB_SHA256;
	let text = await readFile(file, "utf8").catch(() => undefined);
	if (text !== undefined && sha256(text) !== expected) text = undefined;
	if (text === undefined) {
		try {
			const download = options.download ?? (async () => {
				const response = await fetch(VOCABULARY_URLS[ENCODING]!);
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				return response.text();
			});
			const fetched = await download();
			if (sha256(fetched) !== expected) throw new Error("vocabulary checksum mismatch");
			await mkdir(join(paths.curatorDir, "vocab"), { recursive: true });
			await writeFile(`${file}.tmp`, fetched);
			await rename(`${file}.tmp`, file);
			text = fetched;
		} catch (error) {
			return {
				exact: false,
				warning: `${ENCODING} vocabulary unavailable (${(error as Error).message}); token counts are estimates`,
				count: input => estimateTokens(input, { encoding: ENCODING }),
			};
		}
	}
	const encoding = getTiktoken(ENCODING);
	encoding.loadFromString(text);
	return { exact: true, count: input => encoding.countTokens(input) };
}

export interface SkillTokens {
	/** The skill's entry in every session's system prompt (`- name: description`); 0 when hidden. */
	prompt: number;
	/** The whole SKILL.md, paid when the skill is loaded. */
	body: number;
}

export function skillTokens(tokenizer: Tokenizer, name: string, description: string | undefined, hidden: boolean, skillMd: string): SkillTokens {
	return {
		prompt: hidden ? 0 : tokenizer.count(`- ${name}: ${description ?? ""}`),
		body: tokenizer.count(skillMd),
	};
}
