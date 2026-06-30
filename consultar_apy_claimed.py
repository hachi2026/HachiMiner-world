"""
Busca eventos APYClaimed(address indexed user, uint256 amount)
del contrato HachiLock en los últimos 5000 bloques, filtrado por wallet.
"""

from web3 import Web3
import time

RPC             = "https://worldchain-mainnet.g.alchemy.com/public"
LOCK_ADDRESS    = "0xF743772A09f92850deAFcBDfe6610cFfCe326003"
MY_WALLET       = "0x5aa088f0322c174baba3e4b2c0e1973c26656f38"
BLOCKS_BACK     = 5000
CHUNK_SIZE      = 100

ABI = [
    {
        "anonymous": False,
        "inputs": [
            {"indexed": True,  "name": "user",   "type": "address"},
            {"indexed": False, "name": "amount", "type": "uint256"},
        ],
        "name": "APYClaimed",
        "type": "event",
    }
]


def main():
    w3 = Web3(Web3.HTTPProvider(RPC))
    contract  = w3.eth.contract(address=Web3.to_checksum_address(LOCK_ADDRESS), abi=ABI)
    latest    = w3.eth.block_number
    from_block = max(0, latest - BLOCKS_BACK)

    print(f"Bloque actual : {latest}")
    print(f"Desde bloque  : {from_block}  ({BLOCKS_BACK} bloques atras)")
    print(f"Wallet filtro : {MY_WALLET}\n")

    all_logs = []
    current  = from_block
    chunks   = (latest - from_block) // CHUNK_SIZE + 1
    n        = 0

    while current <= latest:
        n += 1
        end = min(current + CHUNK_SIZE - 1, latest)
        for attempt in range(3):
            try:
                logs = contract.events.APYClaimed.get_logs(from_block=current, to_block=end)
                all_logs.extend(logs)
                break
            except Exception as e:
                if attempt == 2:
                    print(f"  Chunk {current}-{end} falló tras 3 intentos: {e}")
                else:
                    time.sleep(1)
        if n % 50 == 0:
            print(f"  Progreso: chunk {n}/{chunks} (bloque {end})")
        current = end + 1
        time.sleep(0.05)

    # Filtrar por wallet
    wallet_cs = Web3.to_checksum_address(MY_WALLET)
    mine = [l for l in all_logs if l["args"]["user"].lower() == MY_WALLET.lower()]

    print(f"\nEventos APYClaimed totales en rango : {len(all_logs)}")
    print(f"Eventos de mi wallet                : {len(mine)}\n")

    if not mine:
        print("No se encontraron eventos APYClaimed para esta wallet en los ultimos 5000 bloques.")
        return

    for ev in sorted(mine, key=lambda x: x["blockNumber"]):
        block_num = ev["blockNumber"]
        amount    = ev["args"]["amount"] / 1e18
        tx_hash   = ev["transactionHash"].hex()

        # Obtener timestamp del bloque
        try:
            ts    = w3.eth.get_block(block_num)["timestamp"]
            fecha = time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime(ts))
        except Exception:
            fecha = "timestamp no disponible"

        print(f"  Bloque    : {block_num}")
        print(f"  Fecha/hora: {fecha}")
        print(f"  Monto     : {amount:.4f} HACHI")
        print(f"  TX        : {tx_hash}")
        print()

    total = sum(ev["args"]["amount"] / 1e18 for ev in mine)
    print(f"Total APY cobrado en el periodo: {total:.4f} HACHI")


if __name__ == "__main__":
    main()
