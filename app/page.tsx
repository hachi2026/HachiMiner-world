'use client'

import dynamic from 'next/dynamic'

const HachiMiner = dynamic(() => import('@/components/hachi-miner'), { ssr: false })

export default function Page() {
  return <HachiMiner />
}
