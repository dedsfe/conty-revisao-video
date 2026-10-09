// As peças que uma campanha pode pedir. Quais delas valem para cada campanha é DADO da campanha
// (`required_pieces`), não um if espalhado pelo código.
export const PIECES = ["script", "video", "cover", "caption"] as const;
export type Piece = (typeof PIECES)[number];

export const PIECE_LABEL: Record<Piece, string> = {
  script: "roteiro",
  video: "vídeo",
  cover: "capa",
  caption: "legenda",
};

export function isPiece(value: unknown): value is Piece {
  return typeof value === "string" && (PIECES as readonly string[]).includes(value);
}

// Só o vídeo tem linha do tempo: é o único em que um comentário se prende a um segundo.
export function hasTimeline(piece: Piece): boolean {
  return piece === "video";
}
