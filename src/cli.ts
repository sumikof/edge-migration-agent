import os from 'node:os';
import { getConfig, resolveScenario } from './core.js';
import { locateEdge, locateIEDriver, runIE } from './ie.js';
import { runEdge } from './edge.js';
import { compare } from './compare.js';

const action = process.argv[2] || 'doctor';
const target = process.argv[3] || '';
const scenarioName = process.env.SCENARIO || 'sample';
const config = getConfig();

async function main() {
  if (action === 'doctor') {
    console.log(`Node: ${process.version}; OS: ${os.platform()}`);
    console.log(`Edge: ${locateEdge(config.edgeExecutablePath) ?? 'NOT FOUND'}`);
    console.log(`IEDriver: ${locateIEDriver() ?? 'NOT FOUND'}`);
    console.log(`IE URL: ${config.ieBaseUrl}; Edge URL: ${config.edgeBaseUrl}`);
    console.log('Note: Availability is not proof of successful IE-mode automation.');
    if (!locateEdge(config.edgeExecutablePath) || !locateIEDriver()) process.exitCode = 1;
    return;
  }
  const scenario = resolveScenario(scenarioName);
  if (action === 'run') {
    if (target === 'ie') await runIE(config, scenario);
    else if (target === 'edge') await runEdge(config, scenario);
    else throw new Error('Use run ie or run edge');
    console.log(`PASS ${target} ${scenario.name}`);
    return;
  }
  if (action === 'compare') {
    const result = await compare(config, scenario.name);
    console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.reportPath}`);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  if (action === 'dual') {
    const errors: string[] = [];
    for (const [name, runner] of [['ie', runIE], ['edge', runEdge]] as const) {
      try { await runner(config, scenario); console.log(`PASS ${name}`); }
      catch (e) { errors.push(`${name}: ${e}`); console.error(`FAIL ${name}: ${e}`); }
    }
    try {
      const result = await compare(config, scenario.name);
      console.log(`${result.passed ? 'PASS' : 'FAIL'} comparison: ${result.reportPath}`);
      if (!result.passed) errors.push('comparison differed');
    } catch (e) { errors.push(`comparison: ${e}`); }
    if (errors.length) { console.error(errors.join('\n')); process.exitCode = 1; }
    return;
  }
  throw new Error(`Unknown command: ${action}`);
}

main().catch((err: unknown) => { console.error(err); process.exitCode = 1; });
