/** Flexible JSON-like data received from Pokémon Showdown and OpenRouter. */
export type Data = Record<string, any>;

export interface Pokemon extends Data {
  ident?: string;
  details?: string;
  condition?: string;
  active?: boolean;
  commanding?: boolean;
  ability?: string;
  baseAbility?: string;
  item?: string;
  moves?: string[];
  revealedMoves?: string[];
  revealed_moves?: string[];
  teraType?: string;
  terastallized?: boolean | string;
  stats?: Data;
  boosts?: Record<string, number>;
  volatileEffects?: Data[];
}

export interface BattleSide extends Data {
  id: string;
  name?: string;
  pokemon: Pokemon[];
}

export interface ActiveMove extends Data {
  move: string;
  id: string;
  pp: number;
  maxpp: number;
  target?: string;
  disabled?: boolean;
}

export interface ActiveRequest extends Data {
  moves: ActiveMove[];
  trapped?: boolean;
  maybeTrapped?: boolean;
  canTerastallize?: string | boolean;
}

export interface BattleRequest extends Data {
  rqid?: number;
  wait?: boolean;
  teamPreview?: boolean;
  forceSwitch?: boolean[];
  active?: ActiveRequest[];
  side: BattleSide;
}

export interface BattleSnapshot extends Data {
  turn?: number;
  ownSide?: Data | null;
  opponentSide?: Data | null;
  opponentActive?: Pokemon | null;
  field?: Data | null;
  recentEvents?: string[];
}

export interface LegalAction {
  id: string;
  command: string;
  kind: string;
  description: Data;
}

export interface DecisionContext {
  roomid: string;
  turn: number;
  request: BattleRequest;
}

export interface DecisionRecorder {
  record(roomid: string, type: string, data?: Data): unknown;
}

export interface DecisionResult extends Data {
  source: string;
}
