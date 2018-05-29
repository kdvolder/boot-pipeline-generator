#!/usr/bin/env node
import * as jsyaml from 'js-yaml';
import { yaml2json } from './util';
import * as fs from 'fs';
import * as path from 'path';
import * as shell from 'shelljs';
import * as readline from 'readline-sync';

const TEMPLATES = path.resolve(__dirname, '../templates');

interface Resolver {
  (variable: string): Promise<string | undefined>;
}

interface CachingResolver extends Resolver {
  cache: Map<string, string>;
}

function isExecutable(f : string) : boolean {
  //TODO: use fs.stat somehow?
  return f.endsWith('.sh');  
}

class STE {
  resolver: Resolver;
  templates: string;
  outputPath: string;

  constructor(resolver: Resolver, templatesPath: string, outputPath: string) {
    this.resolver = resolver;
    this.templates = templatesPath;
    this.outputPath = outputPath;
  }

  var_re(templatePath: string): RegExp | null {
    if (templatePath.endsWith('.yml') || templatePath.endsWith('.yaml')) {
      return /\$\{(\w+)\}/g; // Example: ${name}
    } else if (templatePath.endsWith('.sh')) {
      return /\$\$\{(\w+)\}/g; // Example: $${name}
    }
    return null;
  }

  isTemplate(filePath: string): boolean {
    return this.var_re(filePath) !== null;
  }

  async process(): Promise<void> {
    await fswalk(this.templates, '.', {
      doWithFile: async (f, r) => await this.processFile(f, r),
      doWithDir: async (f, r) => await this.processDir(f, r),
    });
  }

  private async processFile(p: string, relativePath: string): Promise<void> {
    console.log('f: ', p);
    let target = path.resolve(this.outputPath, relativePath);
    let basename = path.basename(target);
    if (basename.startsWith('_')) {
      basename = basename.substring(1);
      target = path.join(path.dirname(target), basename);
    }
    let var_re = this.var_re(p);
    if (var_re) {
      let rendered = await this.renderTemplate(var_re, fs.readFileSync(p, 'UTF8'));
      fs.writeFileSync(target, rendered);
      if (isExecutable(p)) {
        fs.chmodSync(target, '755');
      }
    } else {
      shell.cp(p, target);
    }
  }

  private async renderTemplate(re: RegExp, template: string) : Promise<string> {
    let varnames = new Set<string>();
    //Hack: collect all varnames first because resolving them needs to be done with async shite now.
    template.replace(re, (mtch: string, ...more: any[]) => {
      varnames.add(more[0]);
      return mtch;
    });

    let map = new Map<string, string>();
    let iter = varnames.values();
    let varname = iter.next().value;
    while (varname) {
      map.set(varname, await this.resolver(varname) || '');
      varname = iter.next().value;
    }
    return template.replace(re, (mtch: string, ...more: any[]) => {
      let varname = more[0];
      return map.get(varname) || mtch;
    });
  }

  private async processDir(p: string, relativePath: string): Promise<void> {
    console.log('d: ', p);
    shell.mkdir('-p', path.resolve(this.outputPath, relativePath));
  }
}

interface Var {
  start: number;
  name: string;
  end: number;
}

interface PathHandlers {
  doWithFile: (file: string, relativePath: string) => Promise<void>;
  doWithDir: (dir: string, relativePath: string) => Promise<void>;
}

async function fswalk(root: string, relative_path: string, handlers: PathHandlers) : Promise<void> {
  let p = path.resolve(root, relative_path);
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    await handlers.doWithDir(p, relative_path);
    let entries = fs.readdirSync(p);
    for (let index = 0; index < entries.length; index++) {
      const name = entries[index];
      let relativeChild = path.join(relative_path, name);
      await fswalk(root, relativeChild, handlers);
    }
  } else if (stat.isFile()) {
    await handlers.doWithFile(p, relative_path);
  }
}

function readValuesYaml(valuesFile: string): any {
  if (fs.existsSync(valuesFile) && fs.statSync(valuesFile).isFile()) {
    return jsyaml.safeLoad(fs.readFileSync(valuesFile, 'UTF8'));
  }
  return {}; //no values file. Return empy object
}

function storeValuesYaml(valuesFile: string, values: any) {
  fs.writeFileSync(valuesFile, jsyaml.safeDump(values));
}

export interface UserQuestioner {
  (property : string, defaultValue ?: string) : Promise<string>
}

function interactiveResolver(defaults: Resolver, question: UserQuestioner): CachingResolver {
  let alreadyAsked = new Set<string>();
  let cache = new Map<string, string>();

  async function ask(varname: string): Promise<string> {
    let defaultValue = await defaults(varname);
    if (defaultValue && defaultValue.indexOf('\n')>=0) {
      //We don't have a practical way to readline multi-line input. So just use the default as is.
      return defaultValue;
    }
    let answer = await question(varname, defaultValue) || defaultValue || '';
    cache.set(varname, await answer);
    return answer;
  }
  
  let resolve : Resolver = async (varname: string) => {
    if (!alreadyAsked.has(varname)) {
      alreadyAsked.add(varname);
      return await ask(varname);
    }
    return cache.get(varname) || '';
  };
  let cr : any = resolve;
  cr.cache = cache;

  return cr;
}

function appNameFromGitRepo(repoUri: string | undefined): string | undefined {
  if (repoUri === undefined) {
    return;
  }
  let x = repoUri;
  if (x.endsWith('.git')) {
    x = x.substring(0, x.length - '.git'.length);
  }
  let slash = x.lastIndexOf('/');
  if (slash >= 0) {
    x = x.substring(slash + 1);
  }
  return x;
}

function usernameFromGitRepo(repoUri: string | undefined): string | undefined {
  //Example: repoUri = 'git@github.com:kdvolder/hello-boot-pks.git'
  if (repoUri === undefined) {
    return;
  }
  if (repoUri.startsWith('http')) {
    throw new Error('https git repo case not yet implemented');
  }
  let colon = repoUri.indexOf(':');
  let slash = repoUri.indexOf('/', colon);
  if (colon >= 0 && slash >= 0) {
    return repoUri.substring(colon + 1, slash);
  }
  return repoUri;
}

interface RecursiveResolverFunction {
  (self: Resolver): Promise<string | undefined>;
}

function escapeYaml(str : string) : string {
  if (str.indexOf('\n')>=0) {
    return multilineYamlString(str);
  }
  return str;
}

function or(
  r1: RecursiveResolverFunction,
  r2: RecursiveResolverFunction
): RecursiveResolverFunction {
  return async (self: Resolver) => await r1(self) || await r2(self);
}

class RecursiceResolverBuilder {
  private resolvers = new Map<string, RecursiveResolverFunction>();
  private self: Resolver = async name => await this.resolve(name);
  private cache = new Map<string, string>();

  public loadDefaults(yamlValuesFile : string) : void {
    if (fs.existsSync(yamlValuesFile)) {
      let obj = readValuesYaml(yamlValuesFile);
      for (let property in obj) {
        if (obj.hasOwnProperty(property)) {
            this.cache.set(property, escapeYaml(obj[property]));
        }
      }
    }
  }

  public build(): Resolver {
    return this.self;
  }

  public add(name: string, resolveFun: RecursiveResolverFunction): void {
    let existing = this.resolvers.get(name);
    if (existing) {
      resolveFun = or(resolveFun, existing);
    }
    this.resolvers.set(name, resolveFun);
  }

  private async resolve(name: string, chain?: string[]): Promise<string | undefined> {
    if (this.cache.has(name)) {
      return this.cache.get(name);
    }
    chain = chain || [];
    if (chain.includes(name)) {
      throw new Error(`Cyclic dependency detected: ${name} -> ${chain}`);
    }
    chain = chain.concat([name]);
    let propertyResolver = this.resolvers.get(name);
    let resolved: string | undefined = undefined;
    if (!propertyResolver) {
      resolved = `CHANGEME_${name}`;
    } else {
      resolved = await propertyResolver(this.self);
    }
    console.log(`${name} => '${resolved}'`);
    if (resolved) {
      this.cache.set(name, resolved);
    }
    return resolved;
  }
}

function tagForBranch(branch?: string): string {
  if (branch === 'master') {
    return 'latest';
  }
  return branch || 'master';
}

function exec(command: string): string {
  return shell.exec(command, { silent: true }).stdout.toString();
}

function getDockerUser(): string {
  let dockerInfo = exec('docker info');
  let userPattern = /Username: (.*)/;
  let match = userPattern.exec(dockerInfo);

  return (match && match[1].trim()) || 'docker_user';
}

function multilineYamlString(str : string) : string {
  return '|\n  ' + str.replace(/\n/gm, '\n  ').trim();
}

export async function generate_pipeline(questioner : UserQuestioner) : Promise<void> {
  //shell.rm('-rf', './ci');

  let defaults = new RecursiceResolverBuilder();

  defaults.loadDefaults('ci/secrets.yml');

  defaults.add('git_repo_uri', async resolve => exec('git config --get remote.origin.url').trim());
  defaults.add('https_git_repo_uri', async resolve => {
    let uri = await resolve('git_repo_uri');
    // Example: uri = 'git@github.com:kdvolder/hello-boot-pks.git'
    // should become: 'https://github.com/kdvolder/hello-boot-pks.git')
    if (uri && uri.startsWith('git@')) {
      return 'https://'+uri.substring('git@'.length).replace(':', '/');
    }
    return uri;
  });
  defaults.add('git_branch', async resolve => 
    exec('git rev-parse --abbrev-ref HEAD').trim() || 'master'
  );
  defaults.add('app_name', async resolve =>
    appNameFromGitRepo(await resolve('git_repo_uri'))
  );
  defaults.add('docker_tag', async resolve => tagForBranch(await resolve('git_branch')));
  defaults.add('docker_repo', async resolve => {
    let user = await resolve('docker_user');
    return `${await resolve('docker_user')}/${await resolve('app_name')}`;
  });
  defaults.add('docker_image', async resolve => 
    `${await resolve('docker_repo')}:${await resolve('docker_tag')}`
  );
  defaults.add('docker_user', async resolve => getDockerUser());
  defaults.add('git_user', async resolve =>
    usernameFromGitRepo(await resolve('git_repo_uri'))
  );
  defaults.add('helm_release_name', async resolve => 
    await resolve('app_name') + '-' + await resolve('git_branch')
  );
  defaults.add('pipeline_name', async resolve =>
    await resolve('app_name')+'-'+await resolve('git_branch')
  );
  defaults.add('kube_config', async resolve => {
    let home = process.env.HOME;
    if (home) {
      let kube_config_file = path.resolve(home, '.kube', 'config'); 
      if (fs.existsSync(kube_config_file)) {
        return multilineYamlString(shell.cat(kube_config_file).toString());
      }
    }
    return 'INSERT_FULL_CONTENTS_OF_KUBE_CONFIG_FILE';
  });
  let resolver = interactiveResolver(defaults.build(), questioner);
  let te = new STE(resolver, TEMPLATES, '.');
  await te.process();

  console.log(`=========================`);
  resolver.cache.forEach((v, k) => {
    console.log(`${k} = '${v}'`);
  });
  console.log(`=========================`);
}
