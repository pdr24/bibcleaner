/**
 * Golden behavioural corpus (synthetic). Each fixture defines the input,
 * what the sources return, and the expected behaviour. Records are invented
 * under the 10.5555 test prefix so no real metadata is asserted here.
 * Real-world calibration uses scripts/eval-corpus.ts against live sources.
 */
import type { VerificationState } from '../../../core/models/types';
import { work, type MockData } from '../mockSources';

export interface Fixture {
  name: string;
  bib: string;
  mode?: 'verify' | 'clean';
  data: MockData;
  expect: {
    selectedTitle?: string | null;
    ambiguous?: boolean;
    versions?: boolean;
    checks?: Record<string, VerificationState>;
    fields?: Record<string, VerificationState>;
    suggest?: { field: string; value?: string; category?: string }[];
    notSuggest?: { field: string; value?: string }[];
    unavailable?: string[];
    /** No suggestion that replaces/adds metadata may be HIGH or VERY HIGH. */
    noConfidentCorrections?: boolean;
  };
}

const T1 = 'Using AI for IoT Security in Smart Homes';
const cr1 = work('Crossref', {
  title: T1,
  authors: ['John Smith', 'Jane Doe'],
  year: 2024,
  venue: 'Proceedings of the 2024 ACM Conference on Example Security',
  publisher: 'ACM',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
  isbn: ['9781234567890'],
});
const db1 = work('DBLP', {
  title: T1,
  authors: ['John Smith', 'Jane Doe'],
  year: 2024,
  venue: 'EXSEC',
  venueShort: 'EXSEC',
  pages: '120-131',
  doi: '10.5555/1000001',
  type: 'inproceedings',
});

export const corpus: Fixture[] = [
  {
    name: 'ACM-style conference paper with correct DOI',
    bib: `@inproceedings{smith2024,\n  title={${T1}},\n  author={Smith, John and Doe, Jane},\n  booktitle={Proceedings of the 2024 ACM Conference on Example Security},\n  year={2024},\n  doi={10.5555/1000001}\n}`,
    data: { records: [cr1, db1] },
    expect: {
      selectedTitle: T1,
      checks: { 'doi-syntax': 'VERIFIED', 'doi-resolve': 'VERIFIED', 'doi-meta': 'VERIFIED', 'doi-identity': 'VERIFIED' },
      fields: { title: 'VERIFIED', author: 'VERIFIED', year: 'VERIFIED', doi: 'VERIFIED', pages: 'MISSING' },
      suggest: [
        { field: 'pages', value: '120--131' },
        { field: 'title', category: 'format' },
      ],
      notSuggest: [{ field: 'year' }, { field: 'doi' }],
    },
  },
  {
    name: 'incorrect year',
    bib: `@inproceedings{smith2025ai,\n  title={using ai for iot security in smart homes},\n  author={Smith, John and Doe, Jane},\n  year={2025},\n  url={https://example.com/paper}\n}`,
    data: { records: [cr1, db1] },
    expect: {
      selectedTitle: T1,
      fields: { year: 'CONFLICT', doi: 'MISSING' },
      suggest: [
        { field: 'year', value: '2024' },
        { field: 'doi', value: '10.5555/1000001' },
        { field: 'title', value: 'Using {AI} for {IoT} Security in Smart Homes', category: 'format' },
      ],
    },
  },
  {
    name: 'wrong DOI (resolves, but belongs to another paper)',
    bib: `@article{k,\n  title={${T1}},\n  author={John Smith and Jane Doe},\n  year={2024},\n  doi={10.5555/9999999}\n}`,
    data: {
      records: [
        cr1,
        db1,
        work('Crossref', {
          title: 'Protein Folding with Lattice Models',
          authors: ['Ana Ruiz'],
          year: 2019,
          doi: '10.5555/9999999',
          type: 'article',
          venue: 'Journal of Examples',
        }),
      ],
      search: { Crossref: [cr1], DBLP: [db1] },
    },
    expect: { checks: { 'doi-identity': 'CONFLICT' }, selectedTitle: T1, suggest: [{ field: 'doi', value: '10.5555/1000001' }] },
  },
  {
    name: 'DOI does not resolve and no metadata exists',
    bib: `@misc{k,\n  title={${T1}},\n  author={John Smith},\n  year={2024},\n  doi={10.5555/0000000}\n}`,
    data: { records: [cr1], unresolvable: ['10.5555/0000000'], search: { Crossref: [cr1] } },
    expect: { checks: { 'doi-resolve': 'CONFLICT', 'doi-meta': 'UNVERIFIED' } },
  },
  {
    name: 'Crossref unavailable is not "DOI not found"',
    bib: `@inproceedings{k,\n  title={${T1}},\n  author={John Smith and Jane Doe},\n  year={2024},\n  doi={10.5555/1000001}\n}`,
    data: { records: [db1], fail: { Crossref: 'LOOKUP FAILED', DataCite: 'NETWORK UNAVAILABLE' } },
    expect: { checks: { 'doi-meta': 'NOT CHECKED', 'doi-resolve': 'VERIFIED' }, unavailable: ['Crossref', 'DataCite'], selectedTitle: T1 },
  },
  {
    name: 'arXiv preprint with a published conference version',
    bib: `@article{lee2023graph,\n  title={Graph Learning for Classroom Code Review},\n  author={Lee, Min and Park, Soo},\n  journal={arXiv preprint arXiv:2301.00001},\n  year={2023}\n}`,
    data: {
      records: [
        work('arXiv', {
          title: 'Graph Learning for Classroom Code Review',
          authors: ['Min Lee', 'Soo Park'],
          year: 2023,
          venue: 'arXiv',
          arxivId: '2301.00001',
          doi: '10.48550/arXiv.2301.00001',
          isPreprint: true,
          type: 'preprint',
          relatedDois: ['10.5555/2000002'],
        }),
        work('Crossref', {
          title: 'Graph Learning for Classroom Code Review',
          authors: ['Min Lee', 'Soo Park'],
          year: 2024,
          venue: 'Proceedings of the 55th ACM Technical Symposium on Computer Science Education',
          doi: '10.5555/2000002',
          type: 'inproceedings',
          publisher: 'ACM',
          pages: '10-16',
        }),
      ],
    },
    expect: {
      versions: true,
      selectedTitle: 'Graph Learning for Classroom Code Review',
      suggest: [
        { field: 'doi', value: '10.5555/2000002', category: 'version' },
        { field: 'ENTRYTYPE', value: '@inproceedings', category: 'version' },
        { field: 'year', value: '2024', category: 'version' },
      ],
    },
  },
  {
    name: 'ambiguous: same title, different papers, sparse citation',
    bib: `@misc{k,\n  title={Learning to Program},\n  year={2020}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Learning to Program',
          authors: ['Ann Kim'],
          year: 2020,
          venue: 'Journal A',
          doi: '10.5555/3000001',
          type: 'article',
        }),
        work('Crossref', {
          title: 'Learning to Program',
          authors: ['Bo Chen'],
          year: 2020,
          venue: 'Conference B',
          doi: '10.5555/3000002',
          type: 'inproceedings',
        }),
      ],
    },
    expect: { ambiguous: true, selectedTitle: null, noConfidentCorrections: true },
  },
  {
    name: 'FALSE-CORRECTION: same title, different authors',
    bib: `@inproceedings{k,\n  title={Neural Program Repair},\n  author={Smith, John and Brown, Alice},\n  year={2022},\n  booktitle={ICSE}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Neural Program Repair',
          authors: ['Wei Zhang', 'Li Wang', 'Hao Liu'],
          year: 2022,
          venue: 'Proceedings of ICSE',
          doi: '10.5555/4000001',
          type: 'inproceedings',
        }),
      ],
    },
    expect: { noConfidentCorrections: true, notSuggest: [{ field: 'doi' }] },
  },
  {
    name: 'FALSE-CORRECTION: same first author, similar title, same year, different venue',
    bib: `@inproceedings{k,\n  title={Scalable Graph Neural Networks for Code},\n  author={Smith, John and Doe, Jane},\n  year={2023},\n  booktitle={Proceedings of FSE}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Scalable Graph Neural Networks for Molecules',
          authors: ['John Smith', 'Ravi Patel'],
          year: 2023,
          venue: 'Journal of Chemical Informatics',
          doi: '10.5555/5000001',
          type: 'article',
        }),
      ],
    },
    expect: { noConfidentCorrections: true, notSuggest: [{ field: 'doi' }] },
  },
  {
    name: 'conference paper vs later journal extension',
    bib: `@inproceedings{k,\n  title={Fast Fuzzing of Parsers},\n  author={Smith, John and Doe, Jane},\n  booktitle={Proceedings of the International Symposium on Testing (ISSTA)},\n  year={2021}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Fast Fuzzing of Parsers',
          authors: ['John Smith', 'Jane Doe'],
          year: 2021,
          venue: 'Proceedings of the 30th International Symposium on Testing (ISSTA)',
          doi: '10.5555/6000001',
          type: 'inproceedings',
        }),
        work('Crossref', {
          title: 'Fast Fuzzing of Parsers: An Extended Study',
          authors: ['John Smith', 'Jane Doe', 'Omar Ali'],
          year: 2023,
          venue: 'Transactions on Software Testing',
          doi: '10.5555/6000002',
          type: 'article',
        }),
      ],
    },
    expect: {
      selectedTitle: 'Fast Fuzzing of Parsers',
      suggest: [{ field: 'doi', value: '10.5555/6000001' }],
      notSuggest: [{ field: 'doi', value: '10.5555/6000002' }, { field: 'ENTRYTYPE' }],
    },
  },
  {
    name: 'abbreviated authors',
    bib: `@article{k,\n  title={Teaching Recursion with Games},\n  author={Nguyen, T. and Garcia, M. A.},\n  journal={Computer Science Education},\n  year={2022}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Teaching Recursion with Games',
          authors: [
            { family: 'Nguyen', given: 'Thanh' },
            { family: 'Garcia', given: 'Maria A.' },
          ],
          year: 2022,
          venue: 'Computer Science Education',
          doi: '10.5555/7000001',
          type: 'article',
          volume: '32',
          issue: '4',
          pages: '401-420',
        }),
      ],
    },
    expect: {
      fields: { author: 'VERIFIED' },
      suggest: [
        { field: 'author', value: 'Nguyen, Thanh and Garcia, Maria A.' },
        { field: 'volume', value: '32' },
        { field: 'number', value: '4' },
      ],
    },
  },
  {
    name: 'LaTeX-accented and Unicode authors agree',
    bib: `@article{k,\n  title={Parsing with Derivatives Revisited},\n  author={M{\\"u}ller, Hans and Erd\\H{o}s, P{\\'a}l},\n  journal={Journal of Parsing},\n  year={2019}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Parsing with Derivatives Revisited',
          authors: [
            { family: 'Müller', given: 'Hans' },
            { family: 'Erdős', given: 'Pál' },
          ],
          year: 2019,
          venue: 'Journal of Parsing',
          doi: '10.5555/8000001',
          type: 'article',
        }),
      ],
    },
    expect: { fields: { author: 'VERIFIED', title: 'VERIFIED' }, notSuggest: [{ field: 'author' }] },
  },
  {
    name: 'paper with no DOI anywhere (DBLP only)',
    bib: `@inproceedings{k,\n  title={A Workshop Paper on Block-Based Programming},\n  author={Rivera, Luz},\n  booktitle={Blocks Workshop},\n  year={2018}\n}`,
    data: {
      records: [
        work('DBLP', {
          title: 'A Workshop Paper on Block-Based Programming',
          authors: ['Luz Rivera'],
          year: 2018,
          venue: 'Blocks Workshop',
          venueShort: 'Blocks',
          type: 'inproceedings',
        }),
      ],
    },
    expect: { selectedTitle: 'A Workshop Paper on Block-Based Programming', notSuggest: [{ field: 'doi' }], fields: { title: 'VERIFIED' } },
  },
  {
    name: 'verify mode proposes only corrections',
    mode: 'verify',
    bib: `@inproceedings{k,\n  title={${T1}},\n  author={Smith, John and Doe, Jane},\n  year={2025}\n}`,
    data: { records: [cr1, db1] },
    expect: {
      suggest: [{ field: 'year', value: '2024' }],
      notSuggest: [{ field: 'doi' }, { field: 'pages' }, { field: 'KEY' }, { field: 'ENTRY' }],
    },
  },
  // ---- regression fixtures added by the QA pass ----
  {
    // BUG-04: an erratum repeats the title of the paper it corrects. Matching
    // one to the other assigned the erratum's DOI with VERY HIGH confidence.
    name: 'erratum notice must never be matched to the original paper',
    bib: `@inproceedings{k,\n  title={${T1}},\n  author={Smith, John and Doe, Jane},\n  year={2024}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: `Erratum: ${T1}`,
          authors: ['John Smith', 'Jane Doe'],
          year: 2024,
          doi: '10.5555/ERRATUM',
          type: 'article',
        }),
      ],
    },
    expect: { noConfidentCorrections: true, notSuggest: [{ field: 'url', value: 'https://doi.org/10.5555/ERRATUM' }] },
  },
  {
    // Same class: a comment/reply piece carries the title of the work it discusses.
    name: 'comment-on notice must never be matched to the work it discusses',
    bib: `@article{k,\n  title={Lattice Models of Protein Folding},\n  author={Ruiz, Ana},\n  journal={Journal of Examples},\n  year={2019}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Comment on: Lattice Models of Protein Folding',
          authors: ['Ana Ruiz'],
          year: 2019,
          venue: 'Journal of Examples',
          doi: '10.5555/COMMENT',
          type: 'article',
        }),
      ],
    },
    expect: { noConfidentCorrections: true },
  },
  {
    // BUG-03: in version mode, DOI-derived "formatting" suggestions carried the
    // published DOI and were swept up by Accept all.
    name: 'preprint citation: every published-version value is a version change',
    bib: `@article{lee2023,\n  title={Graph Learning for Code Review},\n  author={Lee, Min},\n  journal={arXiv preprint arXiv:2301.00001},\n  year={2023}\n}`,
    data: {
      records: [
        work('arXiv', {
          title: 'Graph Learning for Code Review',
          authors: ['Min Lee'],
          year: 2023,
          venue: 'arXiv',
          arxivId: '2301.00001',
          doi: '10.48550/arXiv.2301.00001',
          isPreprint: true,
          type: 'preprint',
          relatedDois: ['10.5555/2000002'],
        }),
        work('Crossref', {
          title: 'Graph Learning for Code Review',
          authors: ['Min Lee'],
          year: 2024,
          venue: 'Proceedings of Example',
          doi: '10.5555/2000002',
          type: 'inproceedings',
          pages: '1--12',
        }),
      ],
      search: {
        Crossref: [
          work('Crossref', {
            title: 'Graph Learning for Code Review',
            authors: ['Min Lee'],
            year: 2024,
            venue: 'Proceedings of Example',
            doi: '10.5555/2000002',
            type: 'inproceedings',
            pages: '1--12',
          }),
        ],
      },
    },
    expect: {
      versions: true,
      suggest: [
        { field: 'doi', value: '10.5555/2000002', category: 'version' },
        { field: 'url', value: 'https://doi.org/10.5555/2000002', category: 'version' },
      ],
      // the key describes the preprint the entry still cites
      notSuggest: [{ field: 'KEY', value: 'lee_2024_graph' }],
    },
  },
  {
    // Venue acronym from DBLP vs the full proceedings name from Crossref: this
    // scored 0 before the QA pass and risked a spurious venue correction.
    name: 'venue acronym and full proceedings name are the same venue',
    bib: `@inproceedings{k,\n  title={Detecting Malware with Graph Neural Networks},\n  author={Smith, John},\n  booktitle={ACM Conference on Computer and Communications Security},\n  year={2025}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Detecting Malware with Graph Neural Networks',
          authors: ['John Smith'],
          year: 2025,
          venue: 'ACM Conference on Computer and Communications Security',
          doi: '10.5555/9000001',
          type: 'inproceedings',
        }),
        work('DBLP', {
          title: 'Detecting Malware with Graph Neural Networks',
          authors: ['John Smith'],
          year: 2025,
          venue: 'CCS',
          venueShort: 'CCS',
          doi: '10.5555/9000001',
          type: 'inproceedings',
        }),
      ],
    },
    expect: { fields: { booktitle: 'VERIFIED' }, notSuggest: [{ field: 'booktitle' }] },
  },
  {
    name: 'workshop and conference versions of one paper are not interchangeable',
    bib: `@inproceedings{k,\n  title={Block-Based Programming in Middle School Classrooms},\n  author={Rivera, Luz},\n  booktitle={Workshop on Computing Education},\n  year={2021}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Block-Based Programming in Middle School Classrooms',
          authors: ['Luz Rivera'],
          year: 2023,
          venue: 'International Conference on Computing Education Research',
          doi: '10.5555/9000002',
          type: 'inproceedings',
        }),
      ],
    },
    expect: { noConfidentCorrections: true },
  },
  {
    name: 'acronym- and mathematics-heavy title: formatting only, no metadata changes',
    bib: `@article{k,\n  title={Fast GPU Kernels for CNN Inference in $O(n \\\\log n)$ Time},\n  author={Chen, Bo},\n  journal={Journal of Examples},\n  year={2022},\n  doi={10.5555/9000003}\n}`,
    data: {
      records: [
        work('Crossref', {
          title: 'Fast GPU Kernels for CNN Inference in O(n log n) Time',
          authors: ['Bo Chen'],
          year: 2022,
          venue: 'Journal of Examples',
          doi: '10.5555/9000003',
          type: 'article',
        }),
      ],
    },
    expect: {
      suggest: [{ field: 'title', category: 'format' }],
      notSuggest: [{ field: 'year' }, { field: 'author' }, { field: 'journal' }],
    },
  },
];
