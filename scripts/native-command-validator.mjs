#!/usr/bin/env node

import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function object(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value) {
  return typeof value === 'string' && value.length > 0;
}

function strings(value, label, { allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)
      || value.some((item) => !string(item)) || new Set(value).size !== value.length) {
    throw error(`native command contract ${label} is invalid`);
  }
  return value;
}

function error(message) {
  const failure = new Error(message);
  failure.nativeContract = true;
  return failure;
}

const nativeSurfaceKeys = Object.freeze([
  'readonly_commands',
  'service_commands',
  'cutover_commands',
  'cancel',
  'attachment',
  'unsupported_commands',
  'revision',
  'cli',
]);

const nativeCancelSurface = Object.freeze({
  command: 'cancel',
  required: Object.freeze(['--job', '<id>']),
  allow_extra_args: false,
});

const nativeAttachmentSurface = Object.freeze({
  command: 'attachment',
  requires: Object.freeze(['--output', '<absolute path>']),
  policy_operation: 'attachment-download',
  overwrite: false,
});

const nativeRevisionRule = Object.freeze({
  native_cutover_accepts: false,
  project_high_impact_requires: 'one separate 40-character hexadecimal --revision',
});

function validateCli(cli) {
  if (!object(cli)) throw error('native command contract cli surface is invalid');
  const known = strings(cli.known_commands, 'cli known commands');
  const optionFlags = cli.option_flags;
  if (!object(optionFlags) || Object.entries(optionFlags).some(([flag, key]) => !flag.startsWith('-') || !string(key))) {
    throw error('native command contract cli option flags are invalid');
  }
  const booleanOptions = strings(cli.boolean_options, 'cli boolean options', { allowEmpty: true });
  const valueOptions = strings(cli.value_options, 'cli value options', { allowEmpty: true });
  const numericOptions = strings(cli.numeric_options, 'cli numeric options', { allowEmpty: true });
  const optionNames = new Set([...booleanOptions, ...valueOptions]);
  if (booleanOptions.some((name) => valueOptions.includes(name))
      || numericOptions.some((name) => !valueOptions.includes(name))
      || Object.values(optionFlags).some((name) => !optionNames.has(name))) {
    throw error('native command contract cli option types are invalid');
  }
  if (!object(cli.command_options)
      || Object.entries(cli.command_options).some(([command, options]) => {
        return !known.includes(command) || !Array.isArray(options) || options.some((option) => !optionNames.has(option));
      })) {
    throw error('native command contract cli command options are invalid');
  }
  if (!object(cli.positional_arity)
      || Object.entries(cli.positional_arity).some(([command, arity]) => {
        return !known.includes(command) || !Number.isInteger(arity) || arity < 0;
      })) {
    throw error('native command contract cli positional arity is invalid');
  }
  if (!object(cli.actions)
      || Object.entries(cli.actions).some(([command, actions]) => {
        return !known.includes(command) || !Array.isArray(actions) || actions.some((action) => !string(action));
      })) {
    throw error('native command contract cli actions are invalid');
  }
  return true;
}

function validateDependencyDeclaration(dependency) {
  if (!object(dependency) || !string(dependency.module) || dependency.module.startsWith('/')
      || path.posix.normalize(dependency.module).startsWith('../')
      || path.posix.normalize(dependency.module) === '..'
      || !string(dependency.export)
      || !/^[0-9a-f]{40}$/.test(dependency.source_revision ?? '')
      || !/^[0-9a-f]{64}$/.test(dependency.module_sha256 ?? '')) {
    throw error('native command contract dependency declaration is invalid');
  }
  const requiredOptions = strings(dependency.required_options, 'dependency required options', { allowEmpty: true });
  if (requiredOptions.some((option) => !option.startsWith('-'))) {
    throw error('native command contract dependency required options are invalid');
  }
  if (!object(dependency.adapter)) throw error('native command contract dependency adapter is invalid');
  const adapterReadonly = strings(
    dependency.adapter.readonly_commands,
    'dependency adapter readonly surface',
    { allowEmpty: true },
  );
  const adapterUnsupported = strings(
    dependency.adapter.unsupported_commands,
    'dependency adapter unsupported surface',
    { allowEmpty: true },
  );
  if (adapterReadonly.some((surface) => adapterUnsupported.includes(surface))) {
    throw error('native command contract dependency adapter surfaces overlap');
  }
}

function validateNativeSurface(contract) {
  strings(contract.readonly_commands, 'readonly surface');
  strings(contract.service_commands, 'service surface');
  strings(contract.cutover_commands, 'cutover surface');
  if (JSON.stringify(contract.cancel) !== JSON.stringify(nativeCancelSurface)) {
    throw error('native command contract cancel surface is invalid');
  }
  if (JSON.stringify(contract.attachment) !== JSON.stringify(nativeAttachmentSurface)) {
    throw error('native command contract attachment surface is invalid');
  }
  strings(contract.unsupported_commands, 'unsupported surface', { allowEmpty: true });
  if (JSON.stringify(contract.revision) !== JSON.stringify(nativeRevisionRule)) {
    throw error('native command contract revision rule is invalid');
  }
  if (!string(contract.binding)) throw error('native command contract binding is invalid');
  if (!contract.cli) throw error('native command contract cli surface is missing');
  validateCli(contract.cli);
}

export function validateNativeCommandContract(contract) {
  if (!object(contract) || contract.contract_version !== 1
      || contract.runtime !== 'manage-discord-sessions'
      || contract.scope !== 'wrapper-boundary') {
    throw error('native command contract header is invalid');
  }
  const hasNativeSurface = nativeSurfaceKeys.some((key) => Object.hasOwn(contract, key));
  if (hasNativeSurface) {
    if (contract.native_dependency !== undefined) {
      throw error('native command contract cannot combine native surface with a wrapper dependency');
    }
    validateNativeSurface(contract);
  } else {
    if (!Object.hasOwn(contract, 'native_dependency')) {
      throw error('native command contract wrapper dependency is missing');
    }
    validateDependencyDeclaration(contract.native_dependency);
    if (!string(contract.binding)) throw error('native command contract binding is invalid');
  }
  return true;
}

function requireSubset(wrapper, native, label) {
  const nativeSet = new Set(native);
  if (wrapper.some((surface) => !nativeSet.has(surface))) {
    throw error(`native dependency ${label} is narrower than the wrapper surface`);
  }
}

function resolveNativeModule(nativeRoot, declaration) {
  if (typeof nativeRoot !== 'string' || !path.isAbsolute(nativeRoot)) {
    throw error('native dependency root must be absolute');
  }
  let root;
  let modulePath;
  try {
    root = fs.realpathSync(nativeRoot);
    const relative = path.normalize(declaration.module);
    modulePath = path.resolve(root, relative);
    const relativeModule = path.relative(root, modulePath);
    if (relativeModule.startsWith(`..${path.sep}`) || relativeModule === '..') {
      throw new Error('outside root');
    }
    const actualModule = fs.realpathSync(modulePath);
    const actualRelative = path.relative(root, actualModule);
    if (actualRelative.startsWith(`..${path.sep}`) || actualRelative === '..') {
      throw new Error('outside root');
    }
    return actualModule;
  } catch (caught) {
    if (caught?.nativeContract) throw caught;
    throw error('native dependency module is unavailable');
  }
}

function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function nativeSupportsSurface(nativeContract, surface) {
  if (nativeContract.unsupported_commands.includes(surface)) return true;
  const [command, ...actionParts] = surface.split(' ');
  if (!nativeContract.cli.known_commands.includes(command)) return false;
  if (actionParts.length === 0) return true;
  return nativeContract.cli.actions?.[command]?.includes(actionParts.join(' ')) === true;
}

export async function validateNativeDependency(contract, nativeRoot) {
  validateNativeCommandContract(contract);
  const declaration = contract.native_dependency;
  if (!declaration) throw error('native command contract wrapper dependency is missing');
  let nativeContract;
  let modulePath;
  try {
    modulePath = resolveNativeModule(nativeRoot, declaration);
    if (!fs.statSync(modulePath).isFile()) throw new Error('not a file');
    if (sha256File(modulePath) !== declaration.module_sha256) {
      throw error('native dependency module digest does not match the pinned module');
    }
    const namespace = await import(pathToFileURL(modulePath).href);
    nativeContract = namespace[declaration.export];
  } catch (caught) {
    if (caught?.nativeContract) throw caught;
    throw error('native dependency could not be loaded');
  }
  try {
    validateNativeCommandContract(nativeContract);
    const adapter = declaration.adapter;
    requireSubset(adapter.readonly_commands, nativeContract.readonly_commands, 'adapter readonly surface');
    requireSubset(nativeContract.unsupported_commands, adapter.unsupported_commands, 'adapter unsupported surface');
    for (const surface of [...adapter.readonly_commands, ...adapter.unsupported_commands]) {
      if (!nativeSupportsSurface(nativeContract, surface)) {
        throw error('native dependency adapter surface is incompatible');
      }
    }
    const requiredOptions = new Set(Object.keys(nativeContract.cli.option_flags));
    for (const option of declaration.required_options) {
      if (!requiredOptions.has(option)) throw error('native dependency cli options are incompatible');
    }
    return true;
  } catch (caught) {
    if (caught?.nativeContract) throw caught;
    throw error('native dependency contract is incompatible');
  }
}

function splitInvocation(args) {
  const input = [...args];
  if (input[0] === '--instance') {
    if (!string(input[1]) || input[1].startsWith('--')) throw error('native command invocation is invalid');
    input.splice(0, 2);
  }
  return input;
}

function hasForbiddenEqualsForm(args) {
  return args.some((token) => token === '--' || token.startsWith('--revision=') || token.startsWith('--output=') || token.startsWith('--instance='));
}

export async function validateNativeCommandInvocation(contract, args = [], { nativeRoot } = {}) {
  validateNativeCommandContract(contract);
  if (contract.native_dependency && nativeRoot !== undefined) await validateNativeDependency(contract, nativeRoot);
  if (!Array.isArray(args) || args.some((token) => typeof token !== 'string') || hasForbiddenEqualsForm(args)) {
    throw error('native command invocation is invalid');
  }
  const input = splitInvocation(args);
  const command = input[0] ?? 'status';
  const subcommand = input[1];
  const surface = `${command}${subcommand ? ` ${subcommand}` : ''}`;
  const adapter = contract.native_dependency?.adapter;
  const readonlyCommands = adapter?.readonly_commands ?? contract.readonly_commands ?? [];
  const unsupportedCommands = adapter?.unsupported_commands ?? contract.unsupported_commands ?? [];
  if (unsupportedCommands.includes(surface)) throw error('native command is unsupported by the checked-in contract');
  if (readonlyCommands.includes(surface)) return true;
  if (command === 'artifacts') throw error('native artifacts command is unsupported by the checked-in contract');
  if (command === nativeCancelSurface.command) {
    const [flag] = nativeCancelSurface.required;
    if (input.length !== 3 || input[1] !== flag || !string(input[2]) || input[2].startsWith('--')) {
      throw error('native cancel requires --job <id>');
    }
    return true;
  }
  if (command === nativeAttachmentSurface.command) {
    const [flag] = nativeAttachmentSurface.requires;
    const outputs = [];
    for (let index = 1; index < input.length; index += 1) {
      if (input[index] !== flag) continue;
      outputs.push(input[index + 1]);
      index += 1;
    }
    if (outputs.length !== 1 || !string(outputs[0]) || !path.isAbsolute(outputs[0])) {
      throw error('native attachment requires one absolute --output path');
    }
    return true;
  }
  if (!string(command) || command.startsWith('--')) throw error('native command invocation is invalid');
  return true;
}

function parseArgs(argv) {
  const contractIndex = argv.indexOf('--contract');
  const nativeRootIndex = argv.indexOf('--native-root');
  const separatorIndex = argv.indexOf('--');
  if (contractIndex < 0 || separatorIndex < 0 || contractIndex + 1 >= separatorIndex
      || (nativeRootIndex >= 0 && nativeRootIndex + 1 >= separatorIndex)) {
    throw error('native command validator arguments are invalid');
  }
  return {
    contractFile: argv[contractIndex + 1],
    nativeRoot: nativeRootIndex >= 0 ? argv[nativeRootIndex + 1] : undefined,
    invocation: argv.slice(separatorIndex + 1),
  };
}

const entrypoint = path.resolve(process.argv[1] || '');
if (path.resolve(fileURLToPath(import.meta.url)) === entrypoint) {
  try {
    const { contractFile, nativeRoot, invocation } = parseArgs(process.argv.slice(2));
    const contract = JSON.parse(fs.readFileSync(path.resolve(contractFile), 'utf8'));
    await validateNativeCommandInvocation(contract, invocation, { nativeRoot });
  } catch (caught) {
    console.error(`native command contract rejected: ${caught?.nativeContract ? caught.message : 'invalid contract input'}`);
    process.exitCode = 1;
  }
}
