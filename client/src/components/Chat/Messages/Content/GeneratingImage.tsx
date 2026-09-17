import { useLocalize } from '~/hooks';
import Container from './Container';

/**
 * Stands in for an image model's reply until its image has been saved. The caption arrives with
 * the completion, but the picture only appears once it has been decoded, resized and stored — so
 * showing the caption first reads as a finished answer with the image missing.
 */
export default function GeneratingImage() {
  const localize = useLocalize();
  return (
    <Container>
      <div role="status" aria-live="polite" className="text-text-secondary">
        {localize('com_ui_creating_image')}
      </div>
    </Container>
  );
}
