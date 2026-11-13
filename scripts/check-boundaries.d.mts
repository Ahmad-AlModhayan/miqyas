// SPDX-License-Identifier: PolyForm-Shield-1.0.0
export interface BoundaryViolation {
  file: string;
  specifier: string;
  reason: string;
}

export function layerOf(filePath: string): string | null;
export function extractImports(source: string): string[];
export function checkSourceImports(filePath: string, source: string): BoundaryViolation[];
export function checkProjectBoundaries(rootDir?: string): Promise<BoundaryViolation[]>;
