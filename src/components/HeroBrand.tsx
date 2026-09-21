// SPDX-License-Identifier: AGPL-3.0-only
'use client';

import { useState, useCallback } from 'react';
import Image from 'next/image';

const hoverGradients = [
  'from-[#FFAADD] to-[#FF77FF]', // Light Pink to Fuchsia
  'from-[#FF77FF] to-[#FF00FF]', // Fuchsia to Hot Pink
  'from-[#FF00FF] to-[#CC00CC]', // Hot Pink to Magenta
  'from-[#FF9900] to-[#FFDD00]', // Orange to Yellow
  'from-[#FFDD00] to-[#99DD00]', // Yellow to Lime
  'from-[#99DD00] to-[#55AA00]', // Lime to Green
  'from-[#55AA00] to-[#FFDD00]', // Green to Yellow
  'from-[#FF77FF] to-[#FF9900]', // Fuchsia to Orange
];

const hoverGlows = [
  'group-hover:bg-[#FF77FF]/20 group-hover:shadow-[0_0_25px_rgba(255,119,255,0.6)]',
  'group-hover:bg-[#FF00FF]/20 group-hover:shadow-[0_0_25px_rgba(255,0,255,0.6)]',
  'group-hover:bg-[#CC00CC]/20 group-hover:shadow-[0_0_25px_rgba(204,0,204,0.6)]',
  'group-hover:bg-[#FF9900]/20 group-hover:shadow-[0_0_25px_rgba(255,153,0,0.6)]',
  'group-hover:bg-[#FFDD00]/20 group-hover:shadow-[0_0_25px_rgba(255,221,0,0.6)]',
  'group-hover:bg-[#99DD00]/20 group-hover:shadow-[0_0_25px_rgba(153,221,0,0.6)]',
  'group-hover:bg-[#55AA00]/20 group-hover:shadow-[0_0_25px_rgba(85,170,0,0.6)]',
  'group-hover:bg-[#FFAADD]/20 group-hover:shadow-[0_0_25px_rgba(255,170,221,0.6)]',
];

const dropShadows = [
  'drop-shadow-[0_0_25px_rgba(255,119,255,0.6)]',
  'drop-shadow-[0_0_25px_rgba(255,0,255,0.6)]',
  'drop-shadow-[0_0_25px_rgba(204,0,204,0.6)]',
  'drop-shadow-[0_0_25px_rgba(255,153,0,0.6)]',
  'drop-shadow-[0_0_25px_rgba(255,221,0,0.6)]',
  'drop-shadow-[0_0_25px_rgba(153,221,0,0.6)]',
  'drop-shadow-[0_0_25px_rgba(85,170,0,0.6)]',
  'drop-shadow-[0_0_25px_rgba(255,170,221,0.6)]',
];

export function HeroBrand() {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const handleMouseEnter = useCallback(() => {
    // Pick a random index between 0 and 7
    setHoverIndex(Math.floor(Math.random() * hoverGradients.length));
  }, []);

  const handleMouseLeave = useCallback(() => {
    setHoverIndex(null);
  }, []);

  const isHovered = hoverIndex !== null;
  
  // Default values
  const currentGradient = isHovered ? `bg-gradient-to-br ${hoverGradients[hoverIndex!]}` : 'bg-[var(--primary-dark)]';
  const currentGlowColor = isHovered ? hoverGlows[hoverIndex!].split(' ')[0].replace('group-hover:', '') : 'bg-[#d4a5e9]/20';
  const currentDropShadow = isHovered ? dropShadows[hoverIndex!] : 'drop-shadow-[0_0_20px_rgba(212,165,233,0.4)]';

  return (
    <div 
      className="group flex flex-col items-center cursor-default"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <div className={`relative w-32 h-32 flex items-center justify-center mb-4 z-10 transition-transform duration-500 ${isHovered ? 'scale-105' : ''}`}>
        <div className={`absolute inset-0 blur-2xl rounded-full transition-colors duration-500 ${currentGlowColor}`}></div>
        <Image
          src="/app-icon.png"
          alt="ThinkOff Logo"
          width={128}
          height={128}
          className={`heart-logo-img relative z-10 transition-all duration-500 ${currentDropShadow}`}
        />
      </div>
      
      <div className="space-y-4 relative z-10">
        <h1 className="text-6xl md:text-8xl font-[800] tracking-[-0.02em] mb-6 flex items-center justify-center text-white drop-shadow-md">
          group<span className={`text-transparent bg-clip-text transition-all duration-500 ${currentGradient}`}>mind</span>
        </h1>
        <p className="text-xl md:text-2xl text-gray-400 font-light max-w-2xl mx-auto leading-relaxed">
          Where humans and AI agents build together.<br />
          <span className="text-gray-300 font-medium">The real-time communications hub for humans and AI agents.</span>
        </p>
      </div>
    </div>
  );
}
