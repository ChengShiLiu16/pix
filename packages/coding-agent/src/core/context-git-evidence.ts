export type {
	GitEvidenceScope,
	GitEvidenceScopeType,
	GitEvidenceVolatility,
	GitInspectionInfo,
	GitInspectionKind,
} from "./context-evidence/git-detect.ts";
export {
	canReuseGitEvidenceWithoutExecuting,
	detectGitInspection,
	isGitEvidenceDisplayText,
	isGitEvidenceText,
} from "./context-evidence/git-detect.ts";
export type { GitEvidenceDetails, GitEvidenceResult } from "./context-evidence/git-store.ts";
export {
	clearGitEvidenceCache,
	createGitEvidenceResult,
	getGitEvidenceCacheKey,
	gitEvidenceCache,
} from "./context-evidence/git-store.ts";
export { applyGitEvidenceTransform } from "./context-evidence/git-transform.ts";
