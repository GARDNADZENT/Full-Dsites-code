const { execFileSync } = require('child_process');

const siteId = process.env.REEF_SITE_ID;
const previous = process.env.VERCEL_GIT_PREVIOUS_SHA;
const current = process.env.VERCEL_GIT_COMMIT_SHA || 'HEAD';

// Exit 1 tells Vercel to proceed with the build; exit 0 skips the build.
if (!previous || /^0+$/.test(previous)) {
    process.exit(1);
}

try {
    const changed = execFileSync('git', ['diff', '--name-only', previous, current], { encoding: 'utf8' })
        .split(/\r?\n/)
        .filter(Boolean);

    if (changed.length === 0) {
        process.exit(1);
    }

    const runtimeChanged = changed.some(
        file =>
            file.startsWith('new-user-interface-main/') ||
            file.startsWith('packages/') ||
            file === 'package.json' ||
            file === 'package-lock.json'
    );

    if (siteId) {
        // Dedicated per-tenant project: rebuild only for this site or shared runtime changes.
        const siteChanged = changed.some(file => file.startsWith(`sites/${siteId}/`));
        process.exit(runtimeChanged || siteChanged ? 1 : 0);
    }

    // Shared multi-tenant project: runtime configs load dynamically from /api/public-site-config,
    // so only rebuild when the trading app, shared packages, or bundled free-bot XML files change.
    const freeBotsChanged = changed.some(file => /^sites\/[^/]+\/free-bots\//.test(file));
    process.exit(runtimeChanged || freeBotsChanged ? 1 : 0);
} catch {
    // Building is safer than skipping when git history is unavailable (e.g. shallow clone).
    process.exit(1);
}
