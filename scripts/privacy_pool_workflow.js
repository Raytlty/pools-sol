const {generateProof} = require("../lib/generateProof");
const {poseidon, MerkleTree, AccessList, utils} = require("../lib/index");
const {ethers} = require("hardhat");
const {deploy} = require("./hardhat.utils");
const {expect} = require("chai");
const {verifyProof} = require("../lib/verifyProof");
const VERIFIER_JSON = require("../circuits/out/withdraw_from_subset_simple_verifier.json");
const WASM_FNAME =
    "./circuits/out/withdraw_from_subset_simple_js/withdraw_from_subset_simple.wasm";
const ZKEY_FNAME = "./circuits/out/withdraw_from_subset_simple_final.zkey";

const N_DEPOSITS = 2;
const VERBOSE = true;

class Worker {
    constructor() {
        this.secrets = utils.randomFEs(N_DEPOSITS);
        this.denomination = ethers.utils.parseEther('0.001');
        this.fee = ethers.utils.parseEther('0.00001');
        this.poseidonContractAddress = "0xf560f64600900CcCc9f43dC96C59b7EB9BCA43bd"

        this.commitments = this.secrets.map((secret) => poseidon([secret]));
        this.recipient = "0x74934222b7Ce548D8CA9448C18B05041262009c0";
        this.depositTree = new MerkleTree({
            hasher: poseidon,
            levels: 20,
            baseString: "empty"
        });
        this.emptyBlocklist = new AccessList({
            treeType: "blocklist",
            subsetString: ""
        });
        this.emptyBlocklist.allow(N_DEPOSITS - 1);

        this.withdrawalOrder = new Array(N_DEPOSITS);
        for (let i = 0; i < N_DEPOSITS; i++) {
            this.withdrawalOrder[i] = i;
        }
        shuffleArray(this.withdrawalOrder);
    }

    async init() {
        const signers = await ethers.getSigners();
        this.signer = signers[0];
        this.privacyPool = await deploy(
            "PrivacyPool",
            [this.poseidonContractAddress, this.denomination],
            VERBOSE
        );
        this.subsetRegistry = await deploy(
            "SubsetRegistry",
            [],
            VERBOSE,
        );
        this.relayer = this.subsetRegistry.address
        const tx = await this.subsetRegistry.connect(this.signer).addPools([this.privacyPool.address])
        console.log(`Added pools to subsetRegistry at ${tx.hash}`)
        await tx.wait()
    }

    async deposit() {
        for (let i = 0; i < N_DEPOSITS; i++) {
            const tx = await this.privacyPool
                .connect(this.signer)
                .deposit(padLeft(this.commitments[i]), {
                    value: this.denomination
                });
            console.log(`Deposit transaction with txHash ${tx.hash}`)
            await tx.wait()
            await this.depositTree.insert(this.commitments[i]);
        }
    }

    async withdraw() {
        for (const i of this.withdrawalOrder) {
            // message data
            const recipient = this.recipient
            const relayer = this.relayer;
            const fee = this.fee;

            // private inputs
            const secret = this.secrets[i];
            const path = i;
            const { pathElements: mainProof, pathRoot: root } =
                this.depositTree.path(path);
            const { pathElements: subsetProof, pathRoot: subsetRoot } =
                this.emptyBlocklist.path(path);
            // public inputs
            console.log(`mainProof: ${mainProof}, root: ${root}`)
            console.log(`subsetProof: ${subsetProof}, subsetRoot: ${subsetRoot}`)

            const nullifier = poseidon([secret, 1, i]);
            const message = utils.hashMod(
                ["address", "address", "uint"],
                [recipient, relayer, fee]
            );

            // generate zkp
            const input = utils.toProofInput({
                root,
                subsetRoot,
                nullifier,
                message,
                secret,
                path,
                mainProof,
                subsetProof
            });
            const { proof, publicSignals } = await generateProof({
                input,
                wasmFileName: WASM_FNAME,
                zkeyFileName: ZKEY_FNAME
            });

            const flatProof = utils.flattenProof(proof);
            const randomBytes = ethers.utils.randomBytes(32);

            // submit withdrawal
            const tx = await this.subsetRegistry
                .connect(this.signer)
                .withdrawAndRecord(
                    this.privacyPool.address,
                    1,
                    0,
                    randomBytes,
                    /// withdraw
                    flatProof,
                    padLeft(root),
                    padLeft(subsetRoot),
                    padLeft(nullifier),
                    recipient,
                    relayer,
                    fee
                );
            console.log(`Withdraw transaction with txHash ${tx.hash}`)
            await tx.wait()
        }

    }
}
function padLeft(value) {
    return ethers.utils.hexZeroPad(value, 32);
}

function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

async function main() {
    const w = new Worker();
    await w.init()
    await w.deposit()
    await w.withdraw()
}

main()