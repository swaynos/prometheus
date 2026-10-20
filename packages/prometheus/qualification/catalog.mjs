#!/usr/bin/env node
import { workflows, faults } from './scenarios.mjs';

console.log(JSON.stringify({ workflows, faults, note: 'Required observations, not qualification results. No service or model work occurred.' }, null, 2));
