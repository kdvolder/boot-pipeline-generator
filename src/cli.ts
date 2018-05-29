#!/usr/bin/env node
import { generate_pipeline } from './pipeline-builder';
import * as readline from 'readline-sync';

generate_pipeline((msg) => readline.question(msg));