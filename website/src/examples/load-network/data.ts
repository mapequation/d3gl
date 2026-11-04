/**
 * Built-in sample networks for the load-from-file example — one in each format the example
 * accepts, so it has something to show before you pick a file. `parseNetwork` (from
 * `@mapequation/d3gl/network`) dispatches on the filename: `.net` → Pajek, anything else → the
 * plain edge-list parser.
 */

/** Pajek `.net`: two friend groups bridged by a few links, with quoted vertex labels (two long ones, to show `labels({ maxWidth })` trimming). */
export const SAMPLE_PAJEK = `*Vertices 12
1 "Alice"
2 "Bob"
3 "Carol"
4 "Dave"
5 "Erin"
6 "Frank"
7 "Grace"
8 "Heidi"
9 "Ivan"
10 "Judy"
11 "Mallory, who bridges the two friend groups"
12 "Niaj, a long name to show the trimming"
*Edges
1 2
1 3
2 3
3 4
2 4
5 6
5 7
6 7
7 8
6 8
9 10
9 11
10 11
11 12
10 12
4 5
8 9
12 1
`;

/** Plain edge list: `source target [weight]` with integer node ids, `#` comments, whitespace-separated. */
export const SAMPLE_EDGELIST = `# tiny weighted edge list — source target weight
1 2 5
2 3 2
2 4 2
2 5 2
3 4 1
4 5 1
5 3 1
1 6 3
1 7 3
6 7 1
`;
