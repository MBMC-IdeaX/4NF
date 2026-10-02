export type TransportMode = "bus" | "microbus" | "tempo" | "taxi";

export interface Route {
  id: string;
  name: string;
  mode: TransportMode;
}
