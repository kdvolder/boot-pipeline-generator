import * as jsyaml from 'js-yaml';
import * as fs from 'fs';

export function yaml2json(
  inputFileName: string,
  outputFileName?: string
): void {
  const input = fs.readFileSync(inputFileName, { encoding: 'UTF8' });
  const yaml = jsyaml.safeLoad(input);
  const output = JSON.stringify(yaml, null, '  ');

  if (outputFileName) {
    fs.writeFileSync(outputFileName, output);
  } else {
    console.log(output);
  }
}
