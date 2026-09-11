// Metro, taught about the monorepo.
//
// Without this, `import { CASE_STATES } from '@ksdc/contracts'` fails at bundle time with
// a module-not-found that names a path that plainly exists. Metro does not use Node's
// resolution: by default it watches only this directory and looks only in this
// directory's node_modules, so a workspace package one level up is invisible to it.
//
// Two settings fix it, and both are needed:
//
//   watchFolders    tells Metro the repository root is part of the project, so a change in
//                   packages/contracts triggers a rebuild instead of being silently stale.
//   nodeModulesPaths tells the resolver to look at the root node_modules as well as this
//                   one - which is where pnpm's hoisted linker actually puts things.
//
// The repository's .npmrc sets node-linker=hoisted for exactly this reason, and says so.
// With pnpm's default symlinked store Metro cannot follow the links and this file would
// not be enough on its own.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('node:path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '..', '..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];

config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// Prefer this app's own copy when a package exists in both places, so the mobile build
// cannot silently pick up a version the web app pinned for its own reasons.
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
