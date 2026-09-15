/**
 * lint-staged：只对本次提交改动的文件跑检查。
 *
 * 目的是让纪律不依赖记性 —— 越界的 import、格式问题在提交那一刻就被拦下，
 * 而不是等到 CI 或者 code review。
 */

export default {
  "*.{ts,tsx}": ["eslint --fix --max-warnings=0", "prettier --write"],
  "*.{json,md,css,html}": ["prettier --write"],
};
