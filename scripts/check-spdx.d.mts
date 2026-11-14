// SPDX-License-Identifier: Apache-2.0
export interface SpdxViolation {
  file: string;
  reason: string;
}

export function expectedSpdxForFile(filePath: string): 'Apache-2.0' | 'AGPL-3.0-only' | null;
export function extractSpdxHeader(source: string): string | null;
export function checkSpdxHeaders(rootDir?: string): Promise<SpdxViolation[]>;
