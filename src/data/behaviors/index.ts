/**
 * The card behavior table, assembled from one file per color.
 *
 * `npm run pool` fails the build if a card has rules text and no entry here, so a card
 * can never be silently misplayed as a vanilla body.
 */

import type { BehaviorTable } from './shared';
import { WHITE } from './white';
import { BLUE } from './blue';
import { BLACK } from './black';
import { RED } from './red';
import { GREEN } from './green';

export type { Behavior, BehaviorTable } from './shared';

export const BEHAVIORS: BehaviorTable = {
  ...WHITE,
  ...BLUE,
  ...BLACK,
  ...RED,
  ...GREEN,
};
