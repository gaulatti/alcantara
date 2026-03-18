export const slideStyles = `
  @keyframes kenburns {
    0% { transform: scale(1); }
    100% { transform: scale(1.1); }
  }

  @keyframes slideTransition {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  .animate-slide-transition {
    animation: slideTransition 0.8s ease-in-out forwards;
  }

  @keyframes scaleIn {
    from {
      opacity: 0;
      transform: scale(0.8);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .animate-scale-in {
    animation: scaleIn 1s ease-out forwards;
  }

  .animate-fade-in {
    animation: fadeIn 1s ease-out forwards;
  }

  .animate-fade-in-delay {
    animation: fadeIn 1s ease-out 0.3s forwards;
    opacity: 0;
  }

  @keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes slideUpFade {
    from {
      opacity: 0;
      transform: translateY(20px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .animate-slide-up {
    animation: slideUpFade 0.8s ease-out forwards;
  }

  @keyframes marqueeFlow {
    from { transform: translateX(1920px); }
    to { transform: translateX(-100%); }
  }
`;
