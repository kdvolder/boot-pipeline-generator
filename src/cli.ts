#!/usr/bin/env node
import { generate_pipeline } from './pipeline-builder';
import * as readline from 'readline-sync';

//With fake questioner for testing
// generate_pipeline((property, defaultValue) => new Promise<string>((resolve, reject) => {
//   setTimeout(() => {
//     resolve(defaultValue || 'CHANGE_ME_'+property);
//   }, 10);
// })).then(() => console.log('DONE'));

//With real questioner using readline (TODO: use async readline)
generate_pipeline(async (property, defaultValue) => {
  let msg = defaultValue 
    ? `Enter '${property}' default is [${defaultValue}] : `
    : `Enter '${property}' : `;
    return readline.question(msg);
}).then(() => console.log('DONE'));
