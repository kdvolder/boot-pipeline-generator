#!/usr/bin/env node
import * as jsyaml from 'js-yaml';
import { yaml2json } from './util';
import * as fs from 'fs';
import * as path from 'path';
import * as shell from 'shelljs';
import * as readline from 'readline-sync';

const TEMPLATES = path.resolve(__dirname, '../templates');

interface Resolver {
  (variable: string): string | null;
}

function var_re(): RegExp {
  return /\$\{(\w+)\}/g;
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

  isTemplate(filePath: string): boolean {
    // For the time being not processing bash scripts because
    // bash ${var} look just like our template vars
    return path.basename(filePath) === 'pipeline.yml';
  }

  process(): void {
    fswalk(this.templates, '.', {
      doWithFile: (f, r) => this.processFile(f, r),
      doWithDir: (f, r) => this.processDir(f, r),
    });
  }

  private processFile(p: string, relativePath: string): void {
    let target = path.resolve(this.outputPath, relativePath);
    console.log('f: ' + p + ' => ' + target);
    if (this.isTemplate(p)) {
      let rendered = this.renderTemplate(fs.readFileSync(p, 'UTF8'));
      fs.writeFileSync(target, rendered);
    } else {
      shell.cp(p, target);
    }
  }

  private renderTemplate(template: string) {
    return template.replace(var_re(), (mtch: string, ...more: any[]) => {
      let varname = more[0];
      let resolved = this.resolver(varname);
      if (typeof resolved === 'string') {
        return resolved;
      } else {
        return mtch;
      }
    });
  }

  private processDir(p: string, relativePath: string): void {
    console.log('d: ' + relativePath);
    shell.mkdir('-p', path.resolve(this.outputPath, relativePath));
  }
}

interface Var {
  start: number;
  name: string;
  end: number;
}

interface PathHandlers {
  doWithFile: (file: string, relativePath: string) => void;
  doWithDir: (dir: string, relativePath: string) => void;
}

function fswalk(root: string, relative_path: string, handlers: PathHandlers) {
  let p = path.resolve(root, relative_path);
  const stat = fs.statSync(p);
  if (stat.isDirectory()) {
    handlers.doWithDir(p, relative_path);
    let entries = fs.readdirSync(p);
    for (let index = 0; index < entries.length; index++) {
      const name = entries[index];
      let relativeChild = path.join(relative_path, name);
      fswalk(root, relativeChild, handlers);
    }
  } else if (stat.isFile()) {
    handlers.doWithFile(p, relative_path);
  }
}

interface PipelineOpts {
  app_name: string;
  git_uri: string;
  git_branch?: string;
  docker_repo_prefix: string;
  helm_release: string;
}

class Pipeline {
  content: any;
  constructor(content: any) {
    this.content = content;
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

function interactiveResolver(valuesObject: any): Resolver {
  let alreadyAsked = new Set<string>();

  function ask(varname: string): string {
    let defaultValue = valuesObject[varname];
    let msg = defaultValue
      ? `Enter '${varname}' (default '${defaultValue}'): `
      : `Enter '${varname}' : `;
    let answer = readline.question(msg) || defaultValue;
    if (answer == undefined) {
      delete valuesObject[varname];
    } else {
      valuesObject[varname] = answer;
    }
    return answer;
  }

  function resolve(varname: string): string {
    if (!alreadyAsked.has(varname)) {
      alreadyAsked.add(varname);
      return ask(varname);
    }
    return valuesObject[varname];
  }
  return resolve;
}

function generate_stuff() {
  shell.rm('-rf', './test-output');
  let valuesFile = 'values.yml';
  let valuesObj = readValuesYaml(valuesFile);
  valuesObj.git_repo_uri =
    valuesObj.git_repo_uri ||
    shell.exec('git config --get remote.origin.url').stdout.trim();
  let resolver = interactiveResolver(valuesObj);
  let te = new STE(resolver, TEMPLATES, './test-output');
  te.process();
  storeValuesYaml(valuesFile, valuesObj);
}

generate_stuff();
