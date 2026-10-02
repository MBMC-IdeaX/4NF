// A meter box on the bench: writes the protocol/frame.mjs heartbeat once a
// second to a serial device, for testing a validator's RS-485 input with two
// USB-RS485 adapters wired A-to-A, B-to-B.
//
//   node validator/tools/meter-sim.mjs /dev/ttyUSB1 [capacity] [onboard]
//
// The count is fixed at the command line; set onboard equal to capacity to see
// the boarding door hold.

import { openSerial } from '../hw/serial.mjs';
import { encodeFrame, FLAG } from '../../protocol/frame.mjs';

const [device, capacityArg = '42', onboardArg = '12'] = process.argv.slice(2);
if (!device) {
  console.error('usage: meter-sim.mjs <serial device> [capacity] [onboard]');
  process.exit(2);
}
const capacity = Number(capacityArg);
const onboard = Number(onboardArg);
const line = openSerial(device, { baud: 115200 });
let metres = 0;
setInterval(() => {
  metres += 6;
  const flags = FLAG.MOVING | (onboard >= capacity ? FLAG.AT_CAPACITY : 0);
  line.write(encodeFrame({ flags, occupancy: onboard, capacity, odometerMetres: metres, unixSeconds: Math.floor(Date.now() / 1000), openLegs: onboard }));
  process.stdout.write(`\rodometer ${metres} m, ${onboard}/${capacity}${flags & FLAG.AT_CAPACITY ? ' AT CAPACITY' : ''}   `);
}, 1000);
