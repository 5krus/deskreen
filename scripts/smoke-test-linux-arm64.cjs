// Check the packaged files, not just node_modules on the build host.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');

function assertArm64(file) {
	const header = Buffer.alloc(20);
	const fd = fs.openSync(file, 'r');
	try {
		assert.equal(fs.readSync(fd, header, 0, header.length, 0), 20);
	} finally {
		fs.closeSync(fd);
	}
	assert.equal(
		header.subarray(0, 4).toString('hex'),
		'7f454c46',
		`${file}: expected ELF`,
	);
	assert.equal(header[4], 2, `${file}: expected 64-bit ELF`);
	assert.equal(header[5], 1, `${file}: expected little-endian ELF`);
	assert.equal(header.readUInt16LE(18), 183, `${file}: expected AArch64`);
}

function nativeModules(dir) {
	return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(dir, entry.name);
		return entry.isDirectory()
			? nativeModules(file)
			: file.endsWith('.node')
				? [file]
				: [];
	});
}

function stopProcessGroup(pid, signal) {
	try {
		process.kill(-pid, signal);
	} catch (error) {
		if (error.code !== 'ESRCH') {
			console.error(error);
			process.exitCode = 1;
		}
	}
}

async function main() {
	assert.equal(process.platform, 'linux', 'Run this test on Linux ARM64');
	assert.equal(process.arch, 'arm64', 'Run this test on Linux ARM64');
	assert.ok(
		process.argv[2],
		'Usage: node scripts/smoke-test-linux-arm64.cjs <app-directory>',
	);
	const appDir = path.resolve(process.argv[2]);
	const executable = path.join(appDir, 'deskreen-ce');
	assertArm64(executable);
	const modules = nativeModules(
		path.join(appDir, 'resources', 'app.asar.unpacked'),
	);
	assert.ok(
		modules.some((file) =>
			file.endsWith('/@roamhq/wrtc-linux-arm64/wrtc.node'),
		),
		'Packaged ARM64 WebRTC module is missing',
	);
	modules.forEach(assertArm64);
	console.log(
		`Verified AArch64 executable and ${modules.length} native module(s)`,
	);

	const profile = fs.mkdtempSync(
		path.join(os.tmpdir(), 'deskreen-arm64-smoke-'),
	);
	const env = { ...process.env, START_MINIMIZED: 'true' };
	delete env.ELECTRON_RUN_AS_NODE;
	const args = [`--user-data-dir=${profile}`, '--ip', '127.0.0.1'];
	// GitHub's disposable runner does not provide a configured Electron sandbox.
	if (process.env.CI === 'true') args.push('--no-sandbox');
	const child = spawn(executable, args, {
		env,
		stdio: ['ignore', 'pipe', 'pipe'],
		detached: true,
	});
	let output = '';
	let failure;
	let exited = false;
	child.stdout.on('data', (chunk) => {
		output += chunk;
	});
	child.stderr.on('data', (chunk) => {
		output += chunk;
	});
	child.on('error', (error) => {
		failure = error;
	});
	const closed = new Promise((resolve) =>
		child.on('close', () => {
			exited = true;
			resolve();
		}),
	);
	try {
		const deadline = Date.now() + 30000;
		while (Date.now() < deadline) {
			if (failure) throw failure;
			assert.ok(
				!exited,
				`Deskreen exited before startup completed (code ${child.exitCode})`,
			);
			assert.ok(
				!/cachedDataRejected|Uncaught Exception/.test(output),
				'Deskreen failed during startup',
			);
			// Read the port from this process, so another Deskreen instance cannot pass the test.
			const match = output.match(/signaling server is online at port (\d+)/);
			if (match) {
				const response = await fetch(`http://127.0.0.1:${match[1]}/`, {
					signal: AbortSignal.timeout(3000),
				});
				assert.equal(response.status, 200);
				assert.match(await response.text(), /Deskreen CE Viewer/);
				await delay(1000);
				assert.ok(!exited, 'Deskreen exited immediately after starting');
				assert.ok(
					!/cachedDataRejected|Uncaught Exception/.test(output),
					'Deskreen failed during startup',
				);
				console.log('Packaged Deskreen started and served its browser viewer');
				return;
			}
			await delay(200);
		}
		throw new Error('Timed out waiting for packaged Deskreen to start');
	} catch (error) {
		console.error(output);
		throw error;
	} finally {
		if (child.pid) {
			stopProcessGroup(child.pid, 'SIGTERM');
			await Promise.race([closed, delay(3000)]);
			stopProcessGroup(child.pid, 'SIGKILL');
		}
		fs.rmSync(profile, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
