/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @format
 */

const childProcess = require('child_process');
const fs = require('fs');

const usage = `
=== Usage ===
node maestro-android.js <path to app> <app_id> <maestro_flow> <flavor> <working_directory>

@param {string} appPath - Path to the app APK
@param {string} appId - App ID that needs to be launched
@param {string} maestroFlow - Path to the maestro flow to be executed
@param {string} jsengine - The JSEngine to use for the test
@param {string} flavor - Flavor of the app to be launched. Can be 'Release' or 'Debug'
@param {string} workingDirectory - Working directory from where to run Metro
==============
`;

const MAX_ATTEMPTS = 5;

function findAvailableSimulator() {
  const output = childProcess.execSync(
    'xcrun simctl list devices available -j',
  );
  const devices = Object.values(JSON.parse(String(output)).devices)
    .flat()
    .reverse();
  const simulator = devices.find(device => /^iPhone .* Pro$/.test(device.name));

  if (simulator == null) {
    throw new Error('Unable to find an available iPhone Pro simulator');
  }

  return simulator;
}

function launchSimulator(simulator) {
  console.log(`Launching simulator ${simulator.name} (${simulator.udid})`);
  try {
    childProcess.execSync(`xcrun simctl boot "${simulator.udid}"`);
  } catch (error) {
    if (
      !error.message.includes('Unable to boot device in current state: Booted')
    ) {
      throw error;
    }
  }
}

function installAppOnSimulator(appPath, udid) {
  console.log(`Installing app at path ${appPath}`);
  childProcess.execSync(`xcrun simctl install "${udid}" "${appPath}"`);
}

// A remote simulator's localhost is the remote host, so Metro needs a tunnel.
function exposeMetroToSimulator(udid) {
  const simRemote = process.env.SIM_REMOTE_BIN;
  if (!simRemote) {
    return;
  }

  console.log('Exposing local Metro port 8081 to the remote simulator');
  childProcess.execSync(`"${simRemote}" reverse start "${udid}" 8081`, {
    stdio: 'inherit',
  });
}

function bringSimulatorInForeground() {
  // Nothing to foreground on a remote simulator.
  if (process.env.SIM_REMOTE_BIN) {
    return;
  }
  console.log('Bringing simulator in foreground');
  childProcess.execSync('open -a simulator');
}

function sleep(ms) {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

async function launchAppOnSimulator(appId, udid, isDebug) {
  console.log('Launch the app');
  childProcess.execSync(`xcrun simctl launch "${udid}" "${appId}"`);

  if (isDebug) {
    console.log('Wait for metro to warm');
    await sleep(20 * 1000);
  }
}

function startVideoRecording(udid, currentAttempt) {
  console.log(
    `Start video record using pid: video_record_${currentAttempt}.pid`,
  );

  const recordingArgs =
    `simctl io ${udid} recordVideo --force video_record_${currentAttempt}.mov`.split(
      ' ',
    );
  const recordingProcess = childProcess.spawn('xcrun', recordingArgs, {
    detached: true,
    stdio: 'ignore',
  });

  return recordingProcess;
}

// The movie is only written after SIGINT, so returning early truncates it.
const RECORDING_SHUTDOWN_TIMEOUT_MS = 30 * 1000;

function stopVideoRecording(recordingProcess) {
  if (!recordingProcess) {
    console.log("Passed a null recording process. Can't kill it");
    return Promise.resolve();
  }

  console.log(`Stop video record using pid: ${recordingProcess.pid}`);

  if (
    recordingProcess.exitCode != null ||
    recordingProcess.signalCode != null
  ) {
    return Promise.resolve();
  }

  // Awaiting the exit is also what reaps the child: the flows run in a
  // synchronous loop, so nothing else turns the event loop.
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      console.log(
        `Recorder ${recordingProcess.pid} did not exit in time, killing it`,
      );
      recordingProcess.kill('SIGKILL');
    }, RECORDING_SHUTDOWN_TIMEOUT_MS);
    timer.unref?.();

    recordingProcess.once('exit', done);
    recordingProcess.once('error', done);
    recordingProcess.kill('SIGINT');
  });
}

async function executeFlowWithRetries(
  appId,
  udid,
  flow,
  jsengine,
  currentAttempt,
) {
  const recProcess = startVideoRecording(udid, currentAttempt);
  try {
    const timeout = 1000 * 60 * 10; // 10 minutes
    const command = `$HOME/.maestro/bin/maestro --udid="${udid}" test "${flow}" --format junit -e APP_ID="${appId}"`;
    console.info(`Executing flow: ${flow} (attempt ${currentAttempt})`);
    console.log(command);
    childProcess.execSync(`MAESTRO_DRIVER_STARTUP_TIMEOUT=1500000 ${command}`, {
      stdio: 'inherit',
      timeout,
    });

    await stopVideoRecording(recProcess);
  } catch (error) {
    await stopVideoRecording(recProcess);

    if (currentAttempt < MAX_ATTEMPTS) {
      console.info(`Retrying flow: ${flow}`);
      await executeFlowWithRetries(
        appId,
        udid,
        flow,
        jsengine,
        currentAttempt + 1,
      );
    } else {
      console.error(
        `Failed to execute flow ${flow} after ${MAX_ATTEMPTS} attempts.`,
      );
      throw error;
    }
  }
}

async function executeFlows(appId, udid, maestroFlow, jsengine) {
  if (!fs.existsSync(maestroFlow) || !fs.lstatSync(maestroFlow).isDirectory()) {
    await executeFlowWithRetries(appId, udid, maestroFlow, jsengine, 1);
    return;
  }

  for (const file of fs.readdirSync(maestroFlow).sort()) {
    const filePath = `${maestroFlow.replace(/\/$/, '')}/${file}`;
    if (fs.lstatSync(filePath).isDirectory()) {
      // Fragments pulled in via `runFlow`; they have no `launchApp` of their
      // own and fail when run standalone.
      if (file === 'helpers') {
        continue;
      }
      await executeFlows(appId, udid, filePath, jsengine);
    } else if (file.endsWith('.yml') || file.endsWith('.yaml')) {
      await executeFlowWithRetries(appId, udid, filePath, jsengine, 1);
    }
  }
}

async function main(args = process.argv.slice(2)) {
  if (args.length !== 6) {
    throw new Error(`Invalid number of arguments.\n${usage}`);
  }

  const appPath = args[0];
  const appId = args[1];
  const maestroFlow = args[2];
  const jsengine = args[3];
  const isDebug = args[4] === 'Debug';
  const workingDirectory = args[5];

  console.info('\n==============================');
  console.info('Running tests for iOS with the following parameters:');
  console.info(`APP_PATH: ${appPath}`);
  console.info(`APP_ID: ${appId}`);
  console.info(`MAESTRO_FLOW: ${maestroFlow}`);
  console.info(`JS_ENGINE: ${jsengine}`);
  console.info(`IS_DEBUG: ${isDebug}`);
  console.info(`WORKING_DIRECTORY: ${workingDirectory}`);
  console.info('==============================\n');

  const simulator = findAvailableSimulator();
  launchSimulator(simulator);
  installAppOnSimulator(appPath, simulator.udid);
  bringSimulatorInForeground();
  if (isDebug) {
    exposeMetroToSimulator(simulator.udid);
  }
  await launchAppOnSimulator(appId, simulator.udid, isDebug);
  await executeFlows(appId, simulator.udid, maestroFlow, jsengine);
  console.log('Test finished');
}

if (require.main === module) {
  main();
}

module.exports = {
  executeFlows,
  findAvailableSimulator,
};
