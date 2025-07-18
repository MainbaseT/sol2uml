import axios from 'axios'
import { ASTNode } from '@solidity-parser/parser/dist/src/ast-types'
import { parse } from '@solidity-parser/parser'

import { convertAST2UmlClasses } from './converterAST2Classes'
import { UmlClass } from './umlClass'
import { topologicalSortClasses } from './filterClasses'
import { parseSolidityVersion } from './utils/regEx'
import path from 'path'

require('axios-debug-log')
const debug = require('debug')('sol2uml')

export interface Remapping {
    from: RegExp
    to: string
}

export const networks = <const>[
    'ethereum',
    'sepolia',
    'holesky',
    'hoodi',
    'arbitrum',
    'optimism',
    'polygon',
    'avalanche',
    'base',
    'bsc',
    'crono',
    'fantom',
    'sonic',
    'gnosis',
    'moonbeam',
    'celo',
    'scroll',
    'linea',
    'blast',
    'berachain',
    'zksync',
]
export type Network = (typeof networks)[number]

export const setChainId = (network: string): number =>
    // If an integer is passed, return it as is
    /^-?(0|[1-9]\d*)$/.test(network)
        ? parseInt(network)
        : network === 'sepolia'
          ? 11155111
          : network === 'holesky'
            ? 17000
            : network === 'hoodi'
              ? 560048
              : network === 'arbitrum'
                ? 42161
                : network === 'optimism'
                  ? 10
                  : network === 'polygon'
                    ? 137
                    : network === 'avalanche'
                      ? 43114
                      : network === 'base'
                        ? 8453
                        : network === 'bsc'
                          ? 56
                          : network === 'crono'
                            ? 25
                            : network === 'fantom'
                              ? 250
                              : network === 'sonic'
                                ? 146
                                : network === 'gnosis'
                                  ? 100
                                  : network === 'moonbeam'
                                    ? 1284
                                    : network === 'celo'
                                      ? 42220
                                      : network === 'scroll'
                                        ? 534352
                                        : network === 'linea'
                                          ? 59144
                                          : network === 'blast'
                                            ? 81457
                                            : network === 'berachain'
                                              ? 80094
                                              : network === 'zksync'
                                                ? 324
                                                : 1

export class EtherscanParser {
    readonly url: string

    constructor(
        protected apiKey?: string,
        public network: Network = 'ethereum',
        url?: string,
    ) {
        if (url) {
            this.url = url
            return
        }

        if (!apiKey) {
            console.error(
                `The apiKey option must be set when getting verified source code from an Etherscan like explorer`,
            )
            process.exit(1)
        }

        const chainId = setChainId(network)
        debug(`Chain id ${chainId} for network ${network}`)
        this.url = `https://api.etherscan.io/v2/api?chainid=${chainId}`
    }

    /**
     * Parses the verified source code files from Etherscan
     * @param contractAddress Ethereum contract address with a 0x prefix
     * @return Promise with an array of UmlClass objects
     */
    async getUmlClasses(contractAddress: string): Promise<{
        umlClasses: UmlClass[]
        contractName: string
    }> {
        const { files, contractName, remappings } =
            await this.getSourceCode(contractAddress)

        let umlClasses: UmlClass[] = []

        for (const file of files) {
            debug(`Parsing source file ${file.filename}`)
            const node = await this.parseSourceCode(file.code)
            const umlClass = convertAST2UmlClasses(
                node,
                file.filename,
                remappings,
            )
            umlClasses = umlClasses.concat(umlClass)
        }

        return {
            umlClasses,
            contractName,
        }
    }

    /**
     * Get Solidity code from Etherscan for a contract and merges all files
     * into one long string of Solidity code.
     * @param contractAddress Ethereum contract address with a 0x prefix
     * @return Promise string of Solidity code
     */
    async getSolidityCode(
        contractAddress: string,
        filename?: string,
    ): Promise<{ solidityCode: string; contractName: string }> {
        const { files, contractName, compilerVersion, remappings } =
            await this.getSourceCode(contractAddress, filename)

        // Parse the UmlClasses from the Solidity code in each file
        let umlClasses: UmlClass[] = []
        for (const file of files) {
            const node = await this.parseSourceCode(file.code)
            const umlClass = convertAST2UmlClasses(
                node,
                file.filename,
                remappings,
            )
            umlClasses = umlClasses.concat(umlClass)
        }

        // Sort the classes so dependent code is first
        const topologicalSortedClasses = topologicalSortClasses(umlClasses)
        // Get a list of filenames the classes are in
        const sortedFilenames = topologicalSortedClasses.map(
            (umlClass) => umlClass.relativePath,
        )
        // Remove duplicate filenames from the list
        const dependentFilenames = [...new Set(sortedFilenames)]

        // find any files that didn't have dependencies found
        const nonDependentFiles = files.filter(
            (f) => !dependentFilenames.includes(f.filename),
        )
        const nonDependentFilenames = nonDependentFiles.map((f) => f.filename)
        if (nonDependentFilenames.length) {
            debug(
                `Failed to find dependencies to files: ${nonDependentFilenames}`,
            )
        }

        const solidityVersion = parseSolidityVersion(compilerVersion)
        let solidityCode = `pragma solidity =${solidityVersion};\n`

        // output non dependent code before the dependent files just in case sol2uml missed some dependencies
        const filenames = [...nonDependentFilenames, ...dependentFilenames]

        // For each filename
        filenames.forEach((filename) => {
            // Lookup the file that contains the Solidity code
            const file = files.find((f) => f.filename === filename)
            if (!file)
                throw Error(`Failed to find file with filename "${filename}"`)

            // comment out any pragma solidity lines as its set from the compiler version
            const removedPragmaSolidity = file.code.replace(
                /(\s)(pragma\s+solidity.*;)/gm,
                '$1/* $2 */',
            )

            // comment out any import statements
            // match whitespace before import
            // and characters after import up to ;
            // replace all in file and match across multiple lines
            const removedImports = removedPragmaSolidity.replace(
                /^\s*?(import.*?;)/gms,
                '/* $1 */',
            )
            // Rename SPDX-License-Identifier to SPDX--License-Identifier so the merged file will compile
            const removedSPDX = removedImports.replace(/SPDX-/, 'SPDX--')
            solidityCode += removedSPDX
        })
        return {
            solidityCode,
            contractName,
        }
    }

    /**
     * Parses Solidity source code into an ASTNode object
     * @param sourceCode Solidity source code
     * @return Promise with an ASTNode object from @solidity-parser/parser
     */
    async parseSourceCode(sourceCode: string): Promise<ASTNode> {
        try {
            const node = parse(sourceCode, {})

            return node
        } catch (err) {
            throw new Error(
                `Failed to parse solidity code from source code:\n${sourceCode}`,
                { cause: err },
            )
        }
    }

    /**
     * Calls Etherscan to get the verified source code for the specified contract address
     * @param contractAddress Ethereum contract address with a 0x prefix
     * @oaram filename optional, case-sensitive name of the source file without the .sol
     */
    async getSourceCode(
        contractAddress: string,
        filename?: string,
    ): Promise<{
        files: { code: string; filename: string }[]
        contractName: string
        compilerVersion: string
        remappings: Remapping[]
    }> {
        const description = `get verified source code for address ${contractAddress} from Etherscan API.`

        try {
            debug(
                `About to get Solidity source code for ${contractAddress} from ${this.url}`,
            )
            const response: any = await axios.get(this.url, {
                params: {
                    module: 'contract',
                    action: 'getsourcecode',
                    address: contractAddress,
                    apikey: this.apiKey,
                },
            })

            if (!Array.isArray(response?.data?.result)) {
                throw new Error(
                    `Failed to ${description}. No result array in HTTP data: ${JSON.stringify(
                        response?.data,
                    )}`,
                )
            }

            let remappings: Remapping[]
            const results = response.data.result.map((result: any) => {
                if (!result.SourceCode) {
                    throw new Error(
                        `Failed to ${description}. Most likely the contract has not been verified on Etherscan.`,
                    )
                }
                // if multiple Solidity source files
                if (result.SourceCode[0] === '{') {
                    try {
                        let parableResultString = result.SourceCode
                        // This looks like an Etherscan bug but we'll handle it here
                        if (result.SourceCode[1] === '{') {
                            // remove first { and last } from the SourceCode string so it can be JSON parsed
                            parableResultString = result.SourceCode.slice(1, -1)
                        }
                        const sourceCodeObject = JSON.parse(parableResultString)

                        // Get any remapping of filenames from the settings
                        remappings = parseRemappings(
                            sourceCodeObject.settings?.remappings,
                        )

                        // The getsource response from Etherscan is inconsistent so we need to handle both shapes
                        const sourceFiles = sourceCodeObject.sources
                            ? Object.entries(sourceCodeObject.sources)
                            : Object.entries(sourceCodeObject)
                        return sourceFiles.map(
                            ([filename, code]: [
                                string,
                                { content: string },
                            ]) => ({
                                code: code.content,
                                filename,
                            }),
                        )
                    } catch (err) {
                        throw new Error(
                            `Failed to parse Solidity source code from Etherscan's SourceCode. ${result.SourceCode}`,
                            { cause: err },
                        )
                    }
                }
                // if multiple Solidity source files with no Etherscan bug in the SourceCode field
                if (result?.SourceCode?.sources) {
                    const sourceFiles = Object.values(result.SourceCode.sources)
                    // Get any remapping of filenames from the settings
                    remappings = parseRemappings(
                        result.SourceCode.settings?.remappings,
                    )
                    return sourceFiles.map(
                        ([filename, code]: [string, { content: string }]) => ({
                            code: code.content,
                            filename,
                        }),
                    )
                }
                // Solidity source code was not uploaded into multiple files so is just in the SourceCode field
                return {
                    code: result.SourceCode,
                    filename: contractAddress,
                }
            })
            let files = results.flat(1)
            const filenameWithExt = filename + '.sol'
            if (filename) {
                files = files.filter(
                    (r: { filename: string }) =>
                        path.parse(r.filename).base == filenameWithExt,
                )
                if (!files?.length) {
                    throw new Error(
                        `Failed to find source file "${filename}" for contract ${contractAddress}`,
                    )
                }
            }
            return {
                files,
                contractName: response.data.result[0].ContractName,
                compilerVersion: response.data.result[0].CompilerVersion,
                remappings,
            }
        } catch (err) {
            if (err.message) {
                throw err
            }
            if (!err.response) {
                throw new Error(`Failed to ${description}. No HTTP response.`)
            }
            throw new Error(
                `Failed to ${description}. HTTP status code ${err.response?.status}, status text: ${err.response?.statusText}`,
                { cause: err },
            )
        }
    }
}

/**
 * Parses Ethersan's remappings config in its API response
 * @param rawMappings
 */
export const parseRemappings = (rawMappings: string[]): Remapping[] => {
    if (!rawMappings) return []
    return rawMappings.map((mapping: string) => parseRemapping(mapping))
}

/**
 * Parses a single mapping. For example
 * "@openzeppelin/=lib/openzeppelin-contracts/"
 * This is from Uniswap's UniversalRouter in the Settings section after the source files
 * https://etherscan.io/address/0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B#code
 * @param mapping
 */
export const parseRemapping = (mapping: string): Remapping => {
    const equalIndex = mapping.indexOf('=')
    const from = mapping.slice(0, equalIndex)
    const to = mapping.slice(equalIndex + 1)
    return {
        from: new RegExp('^' + from),
        to,
    }
}
